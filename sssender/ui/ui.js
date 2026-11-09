// Page plumbing for apps on sssender: formatting, file picking, credential form,
// link banner, upload name and errors. Run progress is in run-view.js, type toggles in types.js
import { describeExpiry } from "../core/link.js?v=785d500";
import { makeCredentialUploader, normaliseEndpoint } from "../core/uploaders.js?v=785d500";

// --- Formatting --------------------------------------------------------------
export { humanBytes, humanDate, plural } from "../core/format.js?v=785d500";
import { humanBytes, humanDate, plural } from "../core/format.js?v=785d500";

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
// Click to pick, or drop files or directories. onFiles gets File[] with
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
        // Read-only in some browsers. The key then falls back to the basename
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
  // readEntries returns ~100 entries per call, so loop until exhausted
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

// One line for a selectFiles() result: "12 files selected (3.4GB total), …".
// noun is "file" or "sequence file". details(sel) adds counts, e.g. ["2 pairs"]
export function summariseSelection(sel, { noun = "file", details = () => [] } = {}) {
  const skipped = [
    sel.rejected ? `${plural(sel.rejected, "other file")} ignored` : "",
    sel.ignored ? `${plural(sel.ignored, "hidden file")} skipped` : "",
  ].filter(Boolean);
  if (!sel.files.length) {
    const none = sel.rejected || sel.ignored ? `No ${noun}s found in selection` : "";
    return [none, ...skipped].filter(Boolean).join(", ");
  }
  if (sel.error) return "Grouping error";
  const total = `${humanBytes(sel.totalBytes)} total`;
  const head = `${plural(sel.selected.length, noun)} selected (${[...details(sel), total].join(", ")})`;
  return [head, ...skipped].join(", ");
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
  const val = (el) => (el === server ? normaliseEndpoint(el.value) : el.value.trim());
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
// <html data-busy> while a run is going (pages animate as they like), and the
// percentage in the tab title. finish() leaves "100% · title" until stop(), so a
// background tab shows it's done. stop() restores the title.
export function makeBusyIndicator({ progress }) {
  const pageTitle = document.title;
  const root = document.documentElement;
  let timer = null;
  const halt = () => {
    clearInterval(timer);
    timer = null;
  };
  const showPct = () => {
    const pct = Math.min(Math.floor(progress.value || 0), 100);
    document.title = `${pct}% · ${pageTitle}`;
    return pct;
  };
  return {
    start() {
      halt();
      root.dataset.busy = "";
      progress.value = 0; // a previous run leaves it at 100
      const tick = () => {
        if (showPct() >= 100) {
          delete root.dataset.busy;
          halt();
        }
      };
      timer = setInterval(tick, 500);
      tick();
    },
    finish() {
      halt();
      delete root.dataset.busy;
      if (document.title !== pageTitle) showPct();
    },
    stop() {
      halt();
      delete root.dataset.busy;
      document.title = pageTitle;
    },
  };
}

// --- Confirmation dialog -----------------------------------------------------
// A <dialog> holding <form method="dialog">. Resolves true only for the button whose
// value is confirmValue. Cancel, Escape and any other close resolve false.
export function confirmDialog(dialog, confirmValue = "upload") {
  return new Promise((resolve) => {
    dialog.returnValue = "";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === confirmValue), { once: true });
    dialog.showModal();
  });
}

// --- Magic-link banner -------------------------------------------------------
// Returns whether the link has expired. Call again to tick the countdown
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
// A greyed, ticking "<timestamp>--" prefix. The real value is captured at upload
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
    case "unreachable": // the message says what to check, and who can
      return msg;
    case "network":
      return `${msg} Check your internet connection and try again.`;
  }
  // fetch() throws TypeError on network/CORS failures, worded differently by each browser
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
