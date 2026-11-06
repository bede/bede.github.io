// sssender: upload files as they are, via a magic link or S3 credentials, under sssender/
import { DEFAULT_ROOT } from "./core/mint.js?v=4ea40cd";
import { findOversizeFiles, rawTransform } from "./core/pipeline.js?v=4ea40cd";
import { SSSENDER_VERSION, SSSENDER_COMMIT } from "./core/version.js?v=4ea40cd";
import { renderFileList } from "./ui/run-view.js?v=4ea40cd";
import {
  bindCancel,
  bindSelection,
  describeFiles,
  readMagicLink,
  showMode,
  uploadSelection,
} from "./ui/upload-page.js?v=4ea40cd";
import {
  bindCredentialForm,
  bindUploadName,
  confirmDialog,
  humanBytes,
  makeBusyIndicator,
  makeStatus,
  oversizeMessage,
  setButtonDisabled,
} from "./ui/ui.js?v=4ea40cd";

const APP = "sssender";
const ROOT = DEFAULT_ROOT; // credential uploads. A link's prefix is fixed by its policy
const CONCURRENCY = 4; // files in flight at once. The credential uploader caps itself lower

const { link: LINK, linkError } = readMagicLink();

const $ = (id) => document.getElementById(id);
const uploadBtn = $("upload-btn");
const resetBtn = $("reset-btn");
const setStatus = makeStatus($("status"));
const uploadName = bindUploadName({ prefixEl: $("name-prefix"), inputEl: $("run-name") });
const busyIndicator = makeBusyIndicator({ progress: $("run-progress") });
const cancel = bindCancel({ button: $("cancel-btn"), setStatus });
const creds = bindCredentialForm({
  server: $("server"),
  bucket: $("bucket"),
  accessKey: $("access-key"),
  secretKey: $("secret-key"),
  onInput() {
    updateUploadEnabled();
    if (!isBusy && !uploadCompleted && !oversizeFiles.length) setStatus(readyStatus());
  },
});

let fileRows = [];
let isBusy = false;
let uploadCompleted = false;
let oversizeFiles = [];

const linkExpired = showMode({
  link: LINK,
  linkError,
  app: APP,
  version: SSSENDER_VERSION,
  commit: SSSENDER_COMMIT,
  bucket: creds.bucket,
  onTick: () => updateUploadEnabled(),
});

const selection = bindSelection({
  isBusy: () => isBusy,
  onChange(sel) {
    busyIndicator.stop(); // a new selection or Reset clears a finished run's title
    uploadCompleted = false;
    uploadName.rearm();
    oversizeFiles = LINK ? findOversizeFiles(sel.groups, LINK.maxBytes) : [];
    if (sel.error) setStatus(sel.error, "error");
    else if (oversizeFiles.length) {
      setStatus(
        oversizeMessage(oversizeFiles, LINK.maxBytes, "Remove these files, or upload them with S3 credentials."),
        "error"
      );
    } else setStatus(readyStatus());
    $("progress-wrap").style.display = "none";
    fileRows = renderFileList($("file-list"), sel.groups);
    updateUploadEnabled();
  },
});
const groups = () => selection.current().groups;

function readyStatus() {
  if (linkError || linkExpired()) return "";
  if (!groups().length) {
    return LINK ? "Select files to upload" : "Select files and enter S3 credentials";
  }
  if (!LINK && !creds.filled()) return "Enter S3 credentials to upload";
  return "Press 'Upload' to begin";
}

function updateUploadEnabled() {
  const ready = LINK ? !linkExpired() && !oversizeFiles.length : creds.filled();
  setButtonDisabled(uploadBtn, isBusy || uploadCompleted || !!linkError || !ready || !groups().length);
}

function setBusy(busy) {
  isBusy = busy;
  resetBtn.disabled = busy;
  updateUploadEnabled();
  selection.render();
  if (busy) busyIndicator.start();
  else busyIndicator.finish();
}

// The heading's file flies into the bucket while busy (CSS in index.html)
function measureMascot() {
  const mascot = $("mascot");
  const [item, , bucket] = mascot.children;
  mascot.style.setProperty("--travel", `${bucket.offsetLeft - item.offsetLeft}px`);
}

async function upload() {
  const runGroups = groups();
  if (!runGroups.length || isBusy) return;
  // Ask every time, before anything is written
  const files = describeFiles(runGroups);
  const totalBytes = runGroups.reduce((n, g) => n + g.size, 0);
  $("confirm-count").textContent = `${files} (${humanBytes(totalBytes)})`;
  $("confirm-upload").textContent = `Upload ${files}`;
  // Own timestamped dir inside the prefix, so a reused link never overwrites. Fixed
  // now, so the dialog shows the exact path the files will land in.
  const keyBase = (LINK ? LINK.prefix : ROOT) + uploadName.commit();
  $("confirm-dest").textContent = `${LINK ? LINK.bucket : creds.bucket()}/${keyBase}/`;
  if (!(await confirmDialog($("confirm-dialog")))) {
    uploadName.rearm();
    setStatus("Upload cancelled. Nothing was uploaded.");
    return;
  }
  uploadCompleted = await uploadSelection({
    groups: runGroups,
    keyBase,
    link: LINK,
    creds,
    transform: rawTransform,
    client: { app: APP, appVersion: SSSENDER_VERSION, commit: SSSENDER_COMMIT },
    concurrency: CONCURRENCY,
    rows: fileRows,
    view: { doneText: (item) => `done. ${humanBytes(item.size)} uploaded` },
    setStatus,
    setBusy,
    busyIndicator,
    cancel,
  });
  updateUploadEnabled();
}

resetBtn.addEventListener("click", () => {
  if (!isBusy) selection.reset();
});
uploadBtn.addEventListener("click", upload);

setStatus(readyStatus());
updateUploadEnabled();
measureMascot();
document.fonts?.ready.then(measureMascot);
addEventListener("resize", measureMascot);
