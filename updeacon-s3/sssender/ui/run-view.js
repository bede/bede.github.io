// Run progress: the file list, and a view on runUpload's hooks driving the bar, its
// label and a row per group, several in flight at once
import { humanBytes } from "./ui.js?v=6684013";

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

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// "Upload stalled." -> "upload stalled", cut short. The row title has it all
function shortReason(err) {
  const msg = String(err?.message || "").replace(/\s+/g, " ").replace(/\.$/, "").trim();
  if (!msg) return "";
  const lower = msg.charAt(0).toLowerCase() + msg.slice(1);
  return lower.length > 40 ? `${lower.slice(0, 39)}…` : lower;
}

//   transform  null for raw uploads, else { verb, past }, e.g. { verb: "filtering", past: "filtered" }
//   streaming  transform output streams into the upload (credential mode)
//   doneText(item, result) -> a finished row's text
export function makeRunView({
  wrap,
  bar,
  label,
  rows,
  groups,
  transform = null,
  streaming = false,
  doneText = () => "done",
}) {
  const totalBytes = groups.reduce((n, g) => n + g.size, 0);
  const count = groups.length;
  const state = new Map(); // in-flight groups: i -> progress
  let finishedBytes = 0; // input bytes of finished groups, skipped ones included
  let finished = 0; // groups done or skipped

  // Progress in input bytes: read by a transform, else sent
  const progressBytes = () => {
    let n = finishedBytes;
    for (const s of state.values()) n += transform ? s.processed : s.uploaded;
    return Math.min(n, totalBytes);
  };

  const renderRow = (i) => {
    const s = state.get(i);
    const st = rows[i].st;
    if (s.retry) {
      st.textContent = s.retry;
    } else if (s.uploading) {
      const pct = s.uploadTotal ? Math.min(100, (s.uploaded / s.uploadTotal) * 100) : 100;
      st.textContent = `uploading ${pct.toFixed(0)}%`;
    } else if (transform) {
      const size = groups[i].size;
      const pct = size ? Math.min(100, (s.processed / size) * 100) : 100;
      st.textContent = streaming
        ? `${transform.past} ${pct.toFixed(0)}%, uploaded ${humanBytes(s.uploaded)}`
        : `${transform.verb} ${pct.toFixed(0)}%`;
    } else if (s.uploaded) {
      const pct = groups[i].size ? Math.min(100, (s.uploaded / groups[i].size) * 100) : 100;
      st.textContent = `uploading ${pct.toFixed(0)}%`;
    }
  };

  const renderLabel = () => {
    const active = [...state.keys()];
    if (!active.length) return;
    const bytes = progressBytes();
    const pct = totalBytes ? (bytes / totalBytes) * 100 : 0;
    bar.value = pct;
    const where =
      active.length === 1 ? `${active[0] + 1} of ${count}` : `${active.length} at once, ${finished} of ${count} done`;
    // After a transform only a spooled upload moves: show its bytes
    const uploadingOnly = transform && active.every((i) => state.get(i).uploading);
    if (uploadingOnly && active.length === 1) {
      const s = state.get(active[0]);
      label.textContent = `Uploading ${where}: ${humanBytes(s.uploaded)} / ${humanBytes(s.uploadTotal)}`;
      return;
    }
    const verb = transform && !uploadingOnly ? capitalise(transform.verb) : "Uploading";
    label.textContent =
      `${verb} ${where}: ${humanBytes(bytes)} / ${humanBytes(totalBytes)} (${pct.toFixed(1)}%)`;
  };

  const update = (i, patch) => {
    const s = state.get(i);
    if (!s) return; // a late event from a group that already ended
    Object.assign(s, patch);
    renderRow(i);
    renderLabel();
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
      state.set(i, { processed: 0, uploaded: 0, uploadTotal: 0, uploading: false, retry: "" });
      rows[i].li.className = "active";
      rows[i].st.textContent = transform ? `${transform.verb}…` : "uploading…";
      renderLabel();
    },
    onTransformProgress(i, msg) {
      update(i, { processed: msg.bytesProcessed || 0 });
    },
    // Not called when a stream feeds a multipart upload directly
    onUploadStart(i, bytes) {
      update(i, { uploading: true, uploadTotal: bytes });
    },
    onUploadProgress(i, bytes) {
      update(i, { uploaded: bytes, retry: "" });
    },
    // Retry shown on its row (reason on hover) until bytes move again
    onUploadRetry(i, info) {
      if (info.error && rows[i]) rows[i].li.title = info.error.message || String(info.error);
      const reason = shortReason(info.error);
      update(i, {
        retry: info.resumed
          ? ""
          : info.waitingOnline
            ? "waiting for connection"
            : `retrying (attempt ${info.attempt ?? 1})${reason ? `: ${reason}` : ""}`,
      });
    },
    onGroupRetry(i, _item, err) {
      if (rows[i]) rows[i].li.title = err?.message || String(err);
      state.set(i, { processed: 0, uploaded: 0, uploadTotal: 0, uploading: false, retry: "" });
      if (rows[i]) rows[i].st.textContent = "starting again…";
      renderLabel();
    },
    onGroupDone(i, item, result) {
      state.delete(i);
      finishedBytes += groups[i].size;
      finished++;
      rows[i].li.className = "done";
      rows[i].st.textContent = doneText(item, result);
      bar.value = totalBytes ? (finishedBytes / totalBytes) * 100 : 0;
      renderLabel();
    },
    onGroupFailed(i, _item, err) {
      state.delete(i);
      finishedBytes += groups[i].size;
      finished++;
      rows[i].li.className = "failed";
      rows[i].li.title = err?.message || String(err);
      rows[i].st.textContent = "failed, skipped";
      bar.value = totalBytes ? (finishedBytes / totalBytes) * 100 : 0;
      renderLabel();
    },
    // Group i failed fatally and stopped those still in flight
    fail(i) {
      for (const j of state.keys()) {
        if (j === i || !rows[j]) continue;
        rows[j].li.className = "";
        rows[j].st.textContent = "stopped";
      }
      state.clear();
      label.textContent = `Stopped: ${finished} of ${count} done.`;
      if (!rows[i]) return;
      rows[i].li.className = "failed";
      rows[i].st.textContent = "failed";
    },
    cancel() {
      for (const j of state.keys()) {
        if (!rows[j]) continue;
        rows[j].li.className = "";
        rows[j].st.textContent = "cancelled";
      }
      state.clear();
      label.textContent = `Cancelled: ${finished} of ${count} done.`;
    },
    finish(text) {
      bar.value = 100;
      label.textContent = text;
    },
  };
}
