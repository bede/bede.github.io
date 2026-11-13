// Page plumbing for apps on sssender: formatting, file picking, credential form,
// link banner, upload name and errors. Run progress is in run-view.js, type toggles in types.js
import { describeExpiry } from "../core/link.js?v=61b67cc";
import { makeCredentialUploader, normaliseEndpoint } from "../core/uploaders.js?v=61b67cc";

// --- Formatting --------------------------------------------------------------
export { humanBytes, humanDate, plural } from "../core/format.js?v=61b67cc";
import { humanBytes, humanDate, plural } from "../core/format.js?v=61b67cc";

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
// webkitRelativePath stamped on dropped entries, as the picker does.
// anywhere: the whole window takes the drop, for pages with nothing else to drop on
export function bindFilePicker({ zone, input, isBusy, onFiles, anywhere = false }) {
  zone.addEventListener("click", () => {
    if (!isBusy()) input.click();
  });
  input.addEventListener("change", () => onFiles(Array.from(input.files)));
  if (anywhere) {
    bindPageDrop({ zone, isBusy, onFiles });
    return;
  }
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!isBusy()) zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    if (isBusy()) return;
    onFiles(await droppedFiles(e.dataTransfer));
  });
}

// Dragged files raise a full-window overlay whose label ignores the pointer, so its
// dragleave means the drag left the window. Drops are refused while busy or a modal
// is open, and never fall through to the browser opening the file.
function bindPageDrop({ zone, isBusy, onFiles }) {
  const overlay = document.createElement("div");
  overlay.className = "page-drop";
  overlay.hidden = true;
  const label = document.createElement("div");
  label.className = "page-drop-label";
  label.textContent = "Drop files or a directory to select them";
  overlay.append(label);
  document.body.append(overlay);
  const blocked = () => isBusy() || !!document.querySelector(":modal");
  const show = (on) => {
    overlay.hidden = !on;
    zone.classList.toggle("dragover", on);
  };

  addEventListener("dragenter", (e) => {
    if (carriesFiles(e) && !blocked()) show(true);
  });
  // Outside the overlay, whose handlers stop propagation
  addEventListener("dragover", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  });
  addEventListener("drop", (e) => {
    if (carriesFiles(e)) e.preventDefault();
  });
  overlay.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  });
  overlay.addEventListener("dragleave", () => show(false));
  overlay.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    show(false);
    if (!blocked()) onFiles(await droppedFiles(e.dataTransfer));
  });
}

async function droppedFiles(dataTransfer) {
  const entries = Array.from(dataTransfer.items)
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  return entries.length ? await collectEntries(entries) : Array.from(dataTransfer.files || []);
}

const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

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

// One line for a selectFiles() result: "12 files selected (3.4GB), …".
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
  const total = humanBytes(sel.totalBytes);
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

// --- Staying awake ---------------------------------------------------------------
// While a run is going: a screen wake lock, so an idle machine doesn't sleep and drop
// the connections (a closed lid still does), and a warning before the page is closed.
// The browser drops the lock while the page is hidden, so it is retaken on return
export function holdAwake({ doc = globalThis.document, nav = globalThis.navigator, win = globalThis } = {}) {
  let held = true;
  let lock = null;
  const holding = () => lock && !lock.released;
  const request = async () => {
    if (!held || holding() || !nav?.wakeLock || doc?.visibilityState !== "visible") return;
    try {
      const next = await nav.wakeLock.request("screen");
      // A visibility change may have started another request while this one waited
      if (!held || holding()) {
        await next.release().catch(() => {});
        return;
      }
      lock = next;
    } catch (_) {
      // Refused (no secure context, battery saver…): uploads carry on regardless
    }
  };
  const onBeforeUnload = (e) => {
    e.preventDefault();
    e.returnValue = ""; // older browsers
  };
  doc?.addEventListener?.("visibilitychange", request);
  win?.addEventListener?.("beforeunload", onBeforeUnload);
  request();
  return () => {
    held = false;
    doc?.removeEventListener?.("visibilitychange", request);
    win?.removeEventListener?.("beforeunload", onBeforeUnload);
    lock?.release().catch(() => {});
    lock = null;
  };
}

// --- Busy indicator ----------------------------------------------------------
// <html data-busy> while a run is going (pages animate as they like), and the
// percentage in the tab title. finish() leaves "100% · title" until stop(), so a
// background tab shows it's done. stop() restores the title. Holds the page awake
// (holdAwake) from start() to finish() or stop().
export function makeBusyIndicator({ progress }) {
  const pageTitle = document.title;
  const root = document.documentElement;
  let timer = null;
  let release = null;
  const halt = () => {
    clearInterval(timer);
    timer = null;
    release?.();
    release = null;
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
      release = holdAwake();
      const tick = () => {
        if (showPct() >= 100) {
          delete root.dataset.busy;
          clearInterval(timer);
          timer = null;
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

// --- Done dialog ---------------------------------------------------------------
// The confirmation dialog's twin, shown when a run finishes. skipped: [{ label, reason }]
export function showDoneDialog(dialog, { count, dest, skipped = [], skippedCount = "" }) {
  const $in = (id) => dialog.querySelector(`#${id}`);
  $in("done-title").textContent = skipped.length ? "Upload finished, with files skipped" : "Upload complete";
  $in("done-count").textContent = count;
  $in("done-dest").textContent = dest;
  $in("done-skipped").hidden = !skipped.length;
  $in("done-skipped-count").textContent = skippedCount;
  $in("done-skipped-list").replaceChildren(
    ...skipped.map(({ label, reason }) => {
      const li = document.createElement("li");
      const why = document.createElement("span");
      why.className = "reason";
      why.textContent = reason;
      li.append(label, why);
      return li;
    })
  );
  dialog.showModal();
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
