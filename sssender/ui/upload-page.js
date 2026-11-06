// What every upload page shares: the URL's mode, the drop zone and type toggles,
// Cancel, and one upload run. Shared markup ids:
//   mode       creds, mint-entry, usage-creds, usage-link, link-banner
//   selection  dir-zone, dir-input, dir-summary, type-toggles
//   run        progress-wrap, run-progress, run-label
// Pages keep readiness, buttons and transform.
import { humanBytes, plural } from "../core/format.js?v=3b89761";
import { parseMagicLink } from "../core/link.js?v=3b89761";
import { runUpload } from "../core/pipeline.js?v=3b89761";
import { selectFiles } from "../core/select.js?v=3b89761";
import { makeLinkUploader } from "../core/uploaders.js?v=3b89761";
import { makeRunView } from "./run-view.js?v=3b89761";
import { renderTypeToggles } from "./types.js?v=3b89761";
import { bindFilePicker, formatError, renderLinkBanner, renderLinkError, summariseSelection } from "./ui.js?v=3b89761";

const $ = (id) => document.getElementById(id);

// --- Mode ----------------------------------------------------------------------
// The signed policy rides in the fragment, never reaching the web server
export function readMagicLink(hash = location.hash) {
  try {
    return { link: parseMagicLink(hash), linkError: null };
  } catch (err) {
    return { link: null, linkError: `${err.message} Ask whoever sent it for a new one.` };
  }
}

// Show and log the mode. Returns linkExpired(), and calls onTick each minute
export function showMode({ link, linkError, app, version, commit, bucket, onTick }) {
  const banner = $("link-banner");
  if (linkError) {
    $("creds").hidden = true;
    renderLinkError(banner, linkError);
    return () => true;
  }
  if (!link) {
    console.log(`${app} ${version}: credential mode, bucket "${bucket()}" (commit ${commit})`);
    return () => false;
  }
  // Never log the link itself: the signature is a bearer credential
  console.log(`${app} ${version}: magic-link upload to "${link.bucket}/${link.prefix}" at ${link.endpoint} (commit ${commit})`);
  $("creds").hidden = true;
  $("mint-entry").hidden = true; // link recipients have no keys to sign with
  $("usage-creds").hidden = true;
  $("usage-link").hidden = false;
  banner.hidden = false;
  let expired = renderLinkBanner(banner, link);
  setInterval(() => {
    expired = renderLinkBanner(banner, link); // expire in place
    onTick?.();
  }, 60000);
  return () => expired;
}

// --- Selection -----------------------------------------------------------------
// Drop zone over selectFiles(): dropped files, switched-off types, summary, toggles.
// onChange(selection) after each change
export function bindSelection({ options = {}, summarise = (sel) => summariseSelection(sel), isBusy, onChange }) {
  const zone = $("dir-zone");
  const input = $("dir-input");
  let dropped = [];
  let disabled = new Set();
  let selection = selectFiles([]);

  const render = () =>
    renderTypeToggles($("type-toggles"), selection.types, { onToggle: toggle, disabled: isBusy() });
  const refresh = () => {
    selection = selectFiles(dropped, { ...options, disabled });
    $("dir-summary").textContent = summarise(selection);
    zone.classList.toggle("loaded", selection.groups.length > 0);
    render();
    onChange(selection);
  };
  const set = (files) => {
    dropped = files;
    disabled = new Set();
    refresh();
  };
  function toggle(key) {
    if (isBusy()) return;
    if (disabled.has(key)) disabled.delete(key);
    else disabled.add(key);
    refresh();
  }

  bindFilePicker({ zone, input, isBusy, onFiles: set });
  return {
    current: () => selection,
    render, // e.g. to disable the toggles while busy
    reset() {
      input.value = "";
      set([]);
    },
  };
}

// --- Cancel --------------------------------------------------------------------
// start() shows the button and returns the run's signal, end() hides it
export function bindCancel({ button, setStatus }) {
  let ctrl = null;
  button.addEventListener("click", () => {
    if (!ctrl) return;
    button.disabled = true;
    setStatus("Cancelling …");
    ctrl.abort(Object.assign(new Error("Cancelled."), { name: "AbortError" }));
  });
  return {
    start() {
      ctrl = new AbortController();
      button.hidden = false;
      button.disabled = false;
      return ctrl.signal;
    },
    end() {
      ctrl = null;
      button.hidden = true;
    },
  };
}

// --- One upload ----------------------------------------------------------------
export const describeFiles = (groups) => plural(groups.reduce((n, g) => n + g.files.length, 0), "file");

// Upload groups to keyBase via the link or the form's keys, driving the run view
// and status line throughout. Resolves true if the run finished (maybe with skips).
//   transform, client, concurrency   as runUpload
//   rows                             renderFileList's rows
//   view                             more makeRunView options
//   runLabel                         "Uploading", "Filtering and uploading"
//   describe(groups)                 "3 files", "1 pair and 2 files"
//   finishText(done, skipped)        the run view's last line
//   onGroupDone(i, item, result)     e.g. to add up reads
//   setStatus, setBusy, busyIndicator, cancel (bindCancel)
export async function uploadSelection({
  groups,
  keyBase,
  link,
  creds,
  transform,
  client,
  concurrency = 1,
  spoolDir,
  rows,
  view: viewOptions = {},
  runLabel = "Uploading",
  describe = describeFiles,
  finishText = (done, skipped) =>
    `Uploaded ${humanBytes(done.reduce((n, g) => n + g.size, 0))} across ${describe(done)}` +
    (skipped.length ? `; ${describe(skipped)} skipped.` : "."),
  onGroupDone,
  setStatus,
  setBusy,
  busyIndicator,
  cancel,
}) {
  const signal = cancel.start();
  setBusy(true);
  setStatus(`${runLabel} to ${keyBase} …`);
  const uploader = link
    ? makeLinkUploader({ link, onStatus: setStatus, runLabel, ...(spoolDir && { spoolDir }) })
    : creds.uploader({ onStatus: setStatus, runLabel });
  const view = makeRunView({
    wrap: $("progress-wrap"),
    bar: $("run-progress"),
    label: $("run-label"),
    rows,
    groups,
    streaming: !link, // a credential upload streams a transform's output as it comes
    ...viewOptions,
  });
  const skipped = [];
  let started = false;
  try {
    const { failed } = await runUpload({
      groups,
      keyBase,
      uploader,
      transform,
      client,
      concurrency,
      signal,
      hooks: {
        ...view,
        onGroupStart(i, item) {
          if (!started) setStatus(`${runLabel} to ${keyBase}`);
          started = true;
          view.onGroupStart(i, item);
        },
        onGroupDone(i, item, result) {
          onGroupDone?.(i, item, result);
          view.onGroupDone(i, item, result);
        },
        onGroupFailed(i, item, err) {
          console.warn(`skipped ${item.label}:`, err);
          skipped.push(groups[i]);
          view.onGroupFailed(i, item, err);
        },
        onFinalising() {
          view.finish(finishText(groups.filter((g) => !skipped.includes(g)), skipped));
          setStatus("Finalising (writing manifest) …");
        },
      },
    });
    if (failed.length) {
      setStatus(
        `Upload finished, but ${describe(skipped)} failed and ${skipped.length === 1 ? "was" : "were"} skipped ` +
          `(${keyBase}). Hover a failed row for the reason; _FAILED.txt in the bucket lists them.`,
        "error"
      );
    } else setStatus(`Upload complete (${keyBase})`, "success");
    return true;
  } catch (err) {
    busyIndicator.stop();
    if (signal.aborted) {
      view.cancel();
      setStatus(`Upload cancelled. Files already uploaded stay in ${keyBase}/, with no manifest.`);
    } else {
      if (err?.groupIndex != null) view.fail(err.groupIndex);
      console.error(err);
      setStatus(formatError(err), "error");
    }
    return false;
  } finally {
    cancel.end();
    setBusy(false);
  }
}
