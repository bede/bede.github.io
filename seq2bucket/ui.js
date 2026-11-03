// Shared page plumbing for apps built on seq2bucket: formatting, file selection, the
// magic-link banner, the upload-name field, run progress and error messages.
import { SEQ_RE, pairSequenceFiles } from "./pairing.js?v=87dbf05";
import { describeExpiry } from "./link.js?v=87dbf05";
import { makeCredentialUploader } from "./uploaders.js?v=87dbf05";

// --- Formatting --------------------------------------------------------------
export function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function humanBases(bp) {
  const units = ["bp", "kbp", "Mbp", "Gbp", "Tbp"];
  let i = 0;
  while (bp >= 1000 && i < units.length - 1) {
    bp /= 1000;
    i++;
  }
  return `${bp.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function humanDate(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC");
}

function timestampPrefix() {
  // Key-safe ISO 8601 (Zulu), no ms or colons
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function sanitizeName(s) {
  return (s || "").trim().replace(/[\s/\\]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

// --- Small DOM helpers -------------------------------------------------------
export function makeStatus(el) {
  return (msg, kind) => {
    el.textContent = msg;
    el.className = kind || "";
  };
}

export function setButtonDisabled(btn, disabled) {
  btn.disabled = disabled;
  btn.classList.toggle("pulse-glow", !disabled);
}

// --- File selection ----------------------------------------------------------
// Click to pick, or drop files or directories; onFiles gets File[] with
// webkitRelativePath stamped on dropped entries, as the picker does
export function bindFilePicker({ zone, input, isBusy, onFiles }) {
  zone.addEventListener("click", () => {
    if (!isBusy()) input.click();
  });
  input.addEventListener("change", () => onFiles(Array.from(input.files)));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!isBusy()) zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    if (isBusy()) return;
    const entries = Array.from(e.dataTransfer.items)
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    onFiles(entries.length ? await collectEntries(entries) : Array.from(e.dataTransfer.files || []));
  });
}

async function collectEntries(entries, prefix = "") {
  const out = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      try {
        Object.defineProperty(file, "webkitRelativePath", {
          value: prefix + entry.name,
          configurable: true,
        });
      } catch (_) {
        // Read-only in some browsers; key falls back to basename
      }
      out.push(file);
    } else if (entry.isDirectory) {
      const children = await readAllEntries(entry.createReader());
      out.push(...(await collectEntries(children, prefix + entry.name + "/")));
    }
  }
  return out;
}

function readAllEntries(reader) {
  // readEntries returns ~100 entries per call; loop until exhausted
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

// Pair the sequence files in a selection. Never throws: a pairing error comes back
// as `error`, with no groups.
export function selectSequences(files) {
  const seqs = files.filter((f) => SEQ_RE.test(f.name));
  let groups;
  try {
    groups = pairSequenceFiles(seqs);
  } catch (err) {
    return { seqs, groups: [], totalBytes: 0, summary: "Pairing error", error: err?.message || String(err) };
  }
  const totalBytes = groups.reduce((sum, g) => sum + g.size, 0);
  let summary = "";
  if (seqs.length === 0) {
    summary = files.length ? "No fastq/fasta files found in selection" : "";
  } else {
    // Break down only when pairing grouped something; "6 files (6 files)" says nothing
    const pairs = groups.filter((g) => g.kind === "paired").length;
    const unpaired = groups.length - pairs;
    const details = [`${humanBytes(totalBytes)} total`];
    if (pairs) {
      details.unshift(`${pairs} pair${pairs === 1 ? "" : "s"}`, ...(unpaired ? [`${unpaired} unpaired`] : []));
    }
    summary = `${seqs.length} sequence file${seqs.length === 1 ? "" : "s"} selected (${details.join(", ")})`;
  }
  return { seqs, groups, totalBytes, summary, error: null };
}

export function oversizeMessage(files, maxBytes, remedy) {
  const names = files.map((f) => `${f.name} (${humanBytes(f.size)})`).join(", ");
  return (
    `Too large for a magic link, which is capped at ${humanBytes(maxBytes)} per file: ` +
    `${names}. ${remedy}`
  );
}

// --- Credential form ---------------------------------------------------------
// The #creds fields (server, bucket, access key, secret key). onInput fires on any edit.
export function bindCredentialForm({ server, bucket, accessKey, secretKey, onInput }) {
  const fields = [server, bucket, accessKey, secretKey];
  if (onInput) fields.forEach((el) => el.addEventListener("input", onInput));
  const val = (el) => el.value.trim();
  return {
    filled: () => fields.every(val),
    bucket: () => val(bucket),
    // opts: onStatus, plus any makeCredentialUploader override
    uploader: (opts = {}) =>
      makeCredentialUploader({
        endpoint: val(server),
        bucket: val(bucket),
        accessKeyId: val(accessKey),
        secretAccessKey: val(secretKey),
        ...opts,
      }),
  };
}

// --- Busy indicator ----------------------------------------------------------
// Animates the heading's .mascot, if the page has one, and puts the percentage in the
// tab title while a run is going; stops at 100%.
// finish() ends a successful run but leaves "100% · name" in the title until stop(),
// so a background tab still shows it's done; stop() also restores the page title.
export function makeBusyIndicator({ mascot, progress, name }) {
  const pageTitle = document.title;
  let timer = null;
  const halt = () => {
    clearInterval(timer);
    timer = null;
  };
  return {
    start() {
      halt();
      if (mascot) {
        const [dna, , bucket] = mascot.children;
        mascot.style.setProperty("--dna-travel", `${bucket.offsetLeft - dna.offsetLeft}px`);
        mascot.classList.add("busy");
      }
      progress.value = 0; // a previous run leaves it at 100
      const tick = () => {
        const pct = Math.floor(progress.value || 0);
        document.title = `${Math.min(pct, 100)}% · ${name}`;
        if (pct >= 100) {
          mascot?.classList.remove("busy");
          halt();
        }
      };
      timer = setInterval(tick, 500);
      tick();
    },
    finish() {
      halt();
      mascot?.classList.remove("busy");
      if (document.title !== pageTitle) {
        document.title = `${Math.min(Math.floor(progress.value || 0), 100)}% · ${name}`;
      }
    },
    stop() {
      halt();
      mascot?.classList.remove("busy");
      document.title = pageTitle;
    },
  };
}

// --- Confirmation dialog -----------------------------------------------------
// A <dialog> holding <form method="dialog">; resolves true only for the button whose
// value is confirmValue. Cancel, Escape and any other close resolve false.
export function confirmDialog(dialog, confirmValue = "upload") {
  return new Promise((resolve) => {
    dialog.returnValue = "";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === confirmValue), { once: true });
    dialog.showModal();
  });
}

// --- Magic-link banner -------------------------------------------------------
// Returns whether the link has expired; call again to tick the countdown
export function renderLinkBanner(el, link) {
  const { expired, text } = describeExpiry(link.expiresAt);
  el.classList.toggle("expired", expired);
  el.innerHTML = "";

  const dest = document.createElement("div");
  dest.className = "link-dest";
  dest.textContent = `${link.bucket}/${link.prefix.replace(/\/$/, "")}`;

  const note = document.createElement("div");
  note.className = "link-note";
  note.textContent = expired
    ? `This magic link expired ${text} ago (${humanDate(link.expiresAt)}). Ask whoever sent it for a new one.`
    : `Reusable magic link, expires in ${text} (${humanDate(link.expiresAt)})`;

  el.append(dest, note);
  return expired;
}

export function renderLinkError(el, message) {
  el.hidden = false;
  el.classList.add("expired");
  const note = document.createElement("div");
  note.className = "link-note";
  note.textContent = message;
  el.replaceChildren(note);
}

// --- Upload name -------------------------------------------------------------
// A greyed, ticking "<timestamp>--" prefix; the real value is captured at upload
// start and frozen, so the field matches what's uploaded
export function bindUploadName({ prefixEl, inputEl }) {
  let frozen = null;
  const tick = () => {
    prefixEl.textContent = `${frozen ?? timestampPrefix()}--`;
  };
  tick();
  setInterval(tick, 1000);
  return {
    // Commit to a name: returns the directory name for this upload
    commit() {
      const timestamp = timestampPrefix();
      frozen = timestamp;
      inputEl.readOnly = true;
      tick();
      const name = sanitizeName(inputEl.value);
      return name ? `${timestamp}--${name}` : timestamp;
    },
    // A link is reusable: a fresh selection re-arms the field
    rearm() {
      frozen = null;
      inputEl.readOnly = false;
      tick();
    },
  };
}

// --- Run progress ------------------------------------------------------------
export function renderFileList(listEl, groups) {
  listEl.innerHTML = "";
  const rows = groups.map((group) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = group.label;
    const st = document.createElement("span");
    st.className = "st";
    li.append(name, st);
    listEl.appendChild(li);
    return { li, st };
  });
  listEl.style.display = rows.length ? "" : "none";
  return rows;
}

// Drives the progress bar, label and per-group rows from runUpload's hooks.
//   filtering: a transform reports progress before (or while) uploading
//   streaming: filtered output streams straight into the upload (credential mode)
export function makeRunView({
  wrap,
  bar,
  label,
  rows,
  groups,
  filtering = false,
  streaming = false,
  doneText = () => "done",
}) {
  const totalBytes = groups.reduce((n, g) => n + g.size, 0);
  const count = groups.length;
  let before = 0; // input bytes of finished groups
  let cur = null;

  const overall = (bytes) => {
    const pct = totalBytes ? ((before + bytes) / totalBytes) * 100 : 0;
    bar.value = pct;
    return pct;
  };
  const renderRow = (i) => {
    const st = rows[i].st;
    if (cur.uploading) {
      const pct = cur.uploadTotal ? Math.min(100, (cur.uploaded / cur.uploadTotal) * 100) : 100;
      st.textContent = `uploading ${pct.toFixed(0)}%`;
      return;
    }
    if (!filtering) return;
    const size = groups[i].size;
    const pct = size ? Math.min(100, (cur.processed / size) * 100) : 100;
    st.textContent = streaming
      ? `filtered ${pct.toFixed(0)}%, uploaded ${humanBytes(cur.uploaded)}`
      : `filtering ${pct.toFixed(0)}%`;
  };

  wrap.style.display = "block";
  bar.value = 0;
  label.textContent = "";
  rows.forEach(({ li, st }) => {
    li.className = "";
    st.textContent = "queued";
  });

  return {
    onGroupStart(i) {
      cur = { processed: 0, uploaded: 0, uploadTotal: 0, uploading: false };
      rows[i].li.className = "active";
      rows[i].st.textContent = filtering ? "filtering…" : "uploading…";
    },
    onTransformProgress(i, msg) {
      cur.processed = msg.bytesProcessed || 0;
      const pct = overall(cur.processed);
      label.textContent =
        `Filtering ${i + 1} of ${count}: ` +
        `${humanBytes(before + cur.processed)} / ${humanBytes(totalBytes)} (${pct.toFixed(1)}%)`;
      renderRow(i);
    },
    // Not called when a stream feeds a multipart upload directly
    onUploadStart(i, bytes) {
      cur.uploading = true;
      cur.uploadTotal = bytes;
      renderRow(i);
    },
    onUploadProgress(i, bytes) {
      cur.uploaded = bytes;
      if (!filtering) {
        // Nothing else moves the overall bar
        const pct = overall(bytes);
        label.textContent =
          `Uploading ${i + 1} of ${count}: ` +
          `${humanBytes(before + bytes)} / ${humanBytes(totalBytes)} (${pct.toFixed(1)}%)`;
      } else if (cur.uploading) {
        label.textContent =
          `Uploading ${i + 1} of ${count}: ${humanBytes(bytes)} / ${humanBytes(cur.uploadTotal)}`;
      }
      renderRow(i);
    },
    onGroupDone(i, item, result) {
      before += groups[i].size;
      rows[i].li.className = "done";
      rows[i].st.textContent = doneText(item, result);
    },
    fail(i) {
      if (!rows[i]) return;
      rows[i].li.className = "failed";
      rows[i].st.textContent = "failed";
    },
    finish(text) {
      bar.value = 100;
      label.textContent = text;
    },
  };
}

// --- Errors ------------------------------------------------------------------
// err.kind is set where the cause is known for certain (preflight, link, storage…)
export function formatError(err) {
  const name = err?.name || "Error";
  const msg = err?.message || String(err);
  switch (err?.kind) {
    case "credentials":
      return "Authentication failed. Check S3 credentials and try again.";
    case "size":
    case "storage":
      return msg;
    case "link":
      return `${msg}\nThis magic link is no longer valid. Ask whoever sent it for a new one.`;
    case "cors":
      return (
        "Connection failed. Couldn't reach the object store from this page. The " +
        "bucket must allow PUT/POST from this origin and expose the ETag header."
      );
    case "network":
      return `${msg} Check your internet connection and try again.`;
  }
  // fetch() throws TypeError on network/CORS failures; message varies by browser
  if (name === "TypeError" || /CORS|Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return (
      `${msg}. Check bucket CORS policy. The bucket must allow ` +
      `PUT/POST from this origin and expose the ETag header.`
    );
  }
  if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|403/i.test(name + msg)) {
    return `${name}. Check the access key, secret key, and bucket permissions.`;
  }
  return `${name}. ${msg}`;
}
