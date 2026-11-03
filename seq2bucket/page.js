// seq2bucket reference page: upload fa/fq files without filtering, through a magic link or
// with S3 credentials (no fragment), exactly as updeacon-s3 does with filtering.
import { describeGroups } from "./pairing.js?v=6667cc5";
import { parseMagicLink } from "./link.js?v=6667cc5";
import { clientRecord, findOversizeFiles, groupFiles, rawTransform, runUpload } from "./pipeline.js?v=6667cc5";
import { makeLinkUploader } from "./uploaders.js?v=6667cc5";
import { RAW_ROOT } from "./mint.js?v=6667cc5";
import { VERSION, BUILD_COMMIT } from "./version.js?v=6667cc5";
import {
  bindCredentialForm,
  confirmDialog,
  bindFilePicker,
  bindUploadName,
  formatError,
  humanBytes,
  makeBusyIndicator,
  makeRunView,
  makeStatus,
  oversizeMessage,
  renderFileList,
  renderLinkBanner,
  renderLinkError,
  selectSequences,
  setButtonDisabled,
} from "./ui.js?v=6667cc5";


// Signed POST policy in the fragment, so it never reaches the web server
let LINK = null;
let linkError = null;
try {
  LINK = parseMagicLink(location.hash);
} catch (err) {
  linkError = `${err.message} Ask whoever sent it for a new one.`;
}

const $ = (id) => document.getElementById(id);
const dirZone = $("dir-zone");
const dirInput = $("dir-input");
const dirSummary = $("dir-summary");
const uploadBtn = $("upload-btn");
const resetBtn = $("reset-btn");
const fileListEl = $("file-list");
const linkBannerEl = $("link-banner");
const setStatus = makeStatus($("status"));
const uploadName = bindUploadName({ prefixEl: $("name-prefix"), inputEl: $("run-name") });
const busyIndicator = makeBusyIndicator({ mascot: $("mascot"), progress: $("run-progress"), name: "seq2bucket" });
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

let selectedFiles = [];
let fileRows = [];
let isBusy = false;
let uploadCompleted = false;
let linkExpired = false;
let oversizeFiles = [];

function readyStatus() {
  if (linkError || linkExpired) return "";
  if (!selectedFiles.length) {
    return LINK ? "Select sequences to upload" : "Select sequences and enter S3 credentials";
  }
  if (!LINK && !creds.filled()) return "Enter S3 credentials to upload";
  return "Press 'Upload' to begin";
}

function updateUploadEnabled() {
  const ready = LINK ? !linkExpired && !oversizeFiles.length : creds.filled();
  setButtonDisabled(uploadBtn, isBusy || uploadCompleted || !!linkError || !ready || !selectedFiles.length);
}

function setBusy(busy) {
  isBusy = busy;
  resetBtn.disabled = busy;
  updateUploadEnabled();
  if (busy) busyIndicator.start();
  else busyIndicator.finish();
}

function renderBanner() {
  linkExpired = renderLinkBanner(linkBannerEl, LINK);
}

function initMode() {
  if (linkError) {
    $("creds").hidden = true;
    renderLinkError(linkBannerEl, linkError);
    return;
  }
  if (!LINK) {
    console.log(`seq2bucket ${VERSION}: credential mode, bucket "${creds.bucket()}" (commit ${BUILD_COMMIT})`);
    return;
  }
  // Never log the link itself: the signature is a bearer credential
  console.log(
    `seq2bucket ${VERSION}: magic-link upload to "${LINK.bucket}/${LINK.prefix}" ` +
      `at ${LINK.endpoint} (commit ${BUILD_COMMIT})`
  );
  $("creds").hidden = true;
  $("mint-entry").hidden = true; // link recipients have no keys to sign with
  $("usage-creds").hidden = true;
  $("usage-link").hidden = false;
  linkBannerEl.hidden = false;
  renderBanner();
  setInterval(renderBanner, 60000); // tick the countdown, and expire in place
}

function setSelection(files) {
  busyIndicator.stop(); // a new selection or Reset clears a finished run's title
  uploadCompleted = false;
  uploadName.rearm();
  const sel = selectSequences(files);
  selectedFiles = sel.groups;
  dirSummary.textContent = sel.summary;
  dirZone.classList.toggle("loaded", sel.groups.length > 0);
  oversizeFiles = LINK ? findOversizeFiles(selectedFiles, LINK.maxBytes) : [];
  if (sel.error) setStatus(sel.error, "error");
  else if (oversizeFiles.length) {
    setStatus(
      oversizeMessage(oversizeFiles, LINK.maxBytes, "Remove these files, or upload them with S3 credentials."),
      "error"
    );
  } else setStatus(readyStatus());
  $("progress-wrap").style.display = "none";
  fileRows = renderFileList(fileListEl, selectedFiles);
  updateUploadEnabled();
}

async function upload() {
  const groups = selectedFiles;
  if (!groups.length || isBusy) return;
  // Unfiltered human sequence is identifying: ask every time, before anything is written
  const fileCount = groups.flatMap(groupFiles).length;
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  const totalBytes = groups.reduce((n, g) => n + g.size, 0);
  $("privacy-count").textContent = `${files} (${humanBytes(totalBytes)})`;
  $("privacy-confirm").textContent = `Upload ${files}`;
  // Own timestamped dir inside the prefix, so a reused link never overwrites. Fixed
  // now, so the dialog shows the exact path the files will land in.
  const keyBase = (LINK ? LINK.prefix : RAW_ROOT) + uploadName.commit();
  $("privacy-dest").textContent = `${LINK ? LINK.bucket : creds.bucket()}/${keyBase}/`;
  if (!(await confirmDialog($("privacy-dialog")))) {
    uploadName.rearm();
    setStatus("Upload cancelled. Nothing was uploaded.");
    return;
  }
  console.log("seq2bucket: raw upload, no filtering");
  setBusy(true);
  setStatus(`Uploading to ${keyBase} …`);

  const uploader = LINK
    ? makeLinkUploader({
        link: LINK,
        buildClientRecord: () => clientRecord({ app: "seq2bucket", transform: rawTransform.name, groups }),
        humanBytes,
        onStatus: setStatus,
      })
    : creds.uploader({ onStatus: setStatus });
  const view = makeRunView({
    wrap: $("progress-wrap"),
    bar: $("run-progress"),
    label: $("run-label"),
    rows: fileRows,
    groups,
    doneText: (item) => `done. ${humanBytes(item.size)} uploaded`,
  });
  try {
    await runUpload({
      groups,
      keyBase,
      uploader,
      transform: rawTransform,
      hooks: {
        ...view,
        onGroupStart(i, item) {
          if (i === 0) setStatus(`Uploading to ${keyBase}`);
          view.onGroupStart(i, item);
        },
        onFinalising() {
          view.finish(`Uploaded ${humanBytes(groups.reduce((n, g) => n + g.size, 0))} across ${describeGroups(groups)}.`);
          setStatus("Finalising (writing manifest) …");
        },
      },
    });
    setStatus(`Upload complete (${keyBase})`, "success");
    uploadCompleted = true;
  } catch (err) {
    busyIndicator.stop();
    if (err?.groupIndex != null) view.fail(err.groupIndex);
    console.error(err);
    setStatus(formatError(err), "error");
  } finally {
    setBusy(false);
  }
}

bindFilePicker({ zone: dirZone, input: dirInput, isBusy: () => isBusy, onFiles: setSelection });
resetBtn.addEventListener("click", () => {
  if (isBusy) return;
  dirInput.value = "";
  setSelection([]);
});
uploadBtn.addEventListener("click", upload);

initMode();
setStatus(readyStatus());
updateUploadEnabled();
