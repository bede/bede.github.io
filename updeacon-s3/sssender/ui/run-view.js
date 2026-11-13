// Run progress: the file list, and a view on runUpload's hooks driving the bar, its
// label and a row per group, several in flight at once
import { humanBytes } from "./ui.js?v=f40b3fc";

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
// An upload that stops moving says so on its row and after the label, both amber
// (class "trouble"), rather than look frozen until a timeout gives up on it
export const QUIET_NOTICE_MS = 60 * 1000;
const QUIET_TICK_MS = 5 * 1000;
const WAITING = "waiting for connection";

// Keeps the first row in flight in view in a scrolling list (one done row above it
// for context), until the user scrolls it away. Scrolling back to it follows again.
// A no-op without a laid-out list (tests)
function followActive(list, rows) {
  if (!list || typeof list.getBoundingClientRect !== "function") return () => {};
  let following = true;
  let expectedTop = list.scrollTop;
  let current = -1;
  const inView = (li) => {
    const box = list.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  };
  // Replaces the previous run's handler: one list, one run at a time
  list.onscroll = () => {
    if (Math.abs(list.scrollTop - expectedTop) <= 2) return; // ours
    following = current >= 0 && inView(rows[current].li);
    expectedTop = list.scrollTop;
  };
  return (first) => {
    current = first;
    if (!following || first < 0) return;
    const top = rows[Math.max(0, first - 1)].li;
    list.scrollTop += top.getBoundingClientRect().top - list.getBoundingClientRect().top;
    expectedTop = list.scrollTop; // as clamped
  };
}

export function makeRunView({
  wrap,
  bar,
  label,
  rows,
  groups,
  transform = null,
  streaming = false,
  doneText = () => "done",
  nowFn = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  list = rows[0]?.li.parentElement,
}) {
  const totalBytes = groups.reduce((n, g) => n + g.size, 0);
  const count = groups.length;
  const state = new Map(); // in-flight groups: i -> progress
  let finishedBytes = 0; // input bytes of finished groups, skipped ones included
  let finished = 0; // groups done or skipped
  let quietTimer = null;
  const follow = followActive(list, rows);
  const followFirst = () => follow(state.size ? Math.min(...state.keys()) : -1);
  const setTrouble = (el, on) => el?.classList?.toggle("trouble", on);

  // Progress in input bytes: read by a transform, else sent
  const progressBytes = () => {
    let n = finishedBytes;
    for (const s of state.values()) n += transform ? s.processed : s.uploaded;
    return Math.min(n, totalBytes);
  };

  const rowText = (i, s) => {
    if (s.retry) return s.retry;
    if (s.uploading) {
      const pct = s.uploadTotal ? Math.min(100, (s.uploaded / s.uploadTotal) * 100) : 100;
      return `uploading ${pct.toFixed(0)}%`;
    }
    if (transform) {
      const size = groups[i].size;
      const pct = size ? Math.min(100, (s.processed / size) * 100) : 100;
      return streaming
        ? `${transform.past} ${pct.toFixed(0)}%, uploaded ${humanBytes(s.uploaded)}`
        : `${transform.verb} ${pct.toFixed(0)}%`;
    }
    if (s.uploaded) {
      const pct = groups[i].size ? Math.min(100, (s.uploaded / groups[i].size) * 100) : 100;
      return `uploading ${pct.toFixed(0)}%`;
    }
    return null;
  };

  const renderRow = (i) => {
    const s = state.get(i);
    const text = rowText(i, s);
    if (text == null) return;
    rows[i].st.textContent = s.quietMin && !s.retry ? `${text}, no progress for ${s.quietMin} min` : text;
    setTrouble(rows[i].li, Boolean(s.retry || s.quietMin));
  };

  // What's wrong across the groups in flight, for the label: "" when all is well
  const troubleText = () => {
    let waiting = false;
    let retrying = 0;
    let quietMin = 0;
    for (const s of state.values()) {
      if (s.retry === WAITING) waiting = true;
      else if (s.retry) retrying++;
      else quietMin = Math.max(quietMin, s.quietMin);
    }
    if (waiting) return WAITING;
    const parts = [];
    if (retrying) parts.push(`${retrying === 1 ? "1 upload" : `${retrying} uploads`} retrying`);
    if (quietMin) parts.push(`no progress for ${quietMin} min`);
    return parts.join(", ");
  };

  const stopQuietTimer = () => {
    if (quietTimer !== null) clearIntervalFn(quietTimer);
    quietTimer = null;
  };
  const checkQuiet = () => {
    if (!state.size) return stopQuietTimer();
    const now = nowFn();
    let changed = false;
    for (const [i, s] of state) {
      if (!s.uploading && !s.uploaded) continue; // a transform may be slow to start
      const quiet = now - s.movedAt;
      const quietMin = quiet >= QUIET_NOTICE_MS ? Math.floor(quiet / 60000) : 0;
      if (quietMin === s.quietMin) continue;
      s.quietMin = quietMin;
      renderRow(i);
      changed = true;
    }
    if (changed) renderLabel();
  };
  const startQuietTimer = () => {
    if (quietTimer !== null) return;
    quietTimer = setIntervalFn(checkQuiet, QUIET_TICK_MS);
    quietTimer?.unref?.(); // Node (tests): never hold the process open
  };
  const freshState = () => ({
    processed: 0,
    uploaded: 0,
    uploadTotal: 0,
    uploading: false,
    retry: "",
    movedAt: nowFn(),
    quietMin: 0,
  });

  const renderLabel = () => {
    const active = [...state.keys()];
    if (!active.length) return;
    const bytes = progressBytes();
    const pct = totalBytes ? (bytes / totalBytes) * 100 : 0;
    bar.value = pct;
    const one = active.length === 1;
    // After a transform only a spooled upload moves: show its bytes
    const uploadingOnly = transform && active.every((i) => state.get(i).uploading);
    const verb = transform && !uploadingOnly ? capitalise(transform.verb) : "Uploading";
    const overall = `${humanBytes(bytes)} / ${humanBytes(totalBytes)} (${pct.toFixed(1)}%)`;
    let text;
    if (one && uploadingOnly) {
      const s = state.get(active[0]);
      text = `Uploading ${active[0] + 1} of ${count}: ${humanBytes(s.uploaded)} / ${humanBytes(s.uploadTotal)}`;
    } else if (one) {
      text = `${verb} ${active[0] + 1} of ${count}: ${overall}`;
    } else {
      text = `${verb}: ${finished} of ${count} done, ${overall}`;
    }
    const trouble = troubleText();
    label.textContent = trouble ? `${text} · ${trouble}` : text;
    setTrouble(label, Boolean(trouble));
  };
  const settleLabel = (text) => {
    label.textContent = text;
    setTrouble(label, false);
  };

  const update = (i, patch) => {
    const s = state.get(i);
    if (!s) return; // a late event from a group that already ended
    // Bytes moving, or a retry starting over, restarts the quiet clock
    const moved =
      (patch.uploaded ?? 0) > s.uploaded || (patch.processed ?? 0) > s.processed || patch.retry || patch.uploading;
    Object.assign(s, patch);
    if (moved) {
      s.movedAt = nowFn();
      s.quietMin = 0;
    }
    renderRow(i);
    renderLabel();
  };

  wrap.style.display = "block";
  bar.value = 0;
  settleLabel("");
  if (list) list.scrollTop = 0;
  rows.forEach(({ li, st }) => {
    li.className = "";
    st.textContent = "queued";
  });

  return {
    onGroupStart(i) {
      state.set(i, freshState());
      startQuietTimer();
      rows[i].li.className = "active";
      rows[i].st.textContent = transform ? `${transform.verb}…` : "uploading…";
      renderLabel();
      followFirst();
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
            ? WAITING
            : `retrying (attempt ${info.attempt ?? 1})${reason ? `: ${reason}` : ""}`,
      });
    },
    onGroupRetry(i, _item, err) {
      if (rows[i]) rows[i].li.title = err?.message || String(err);
      state.set(i, freshState());
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
      followFirst();
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
      followFirst();
    },
    // Group i failed fatally and stopped those still in flight
    fail(i) {
      for (const j of state.keys()) {
        if (j === i || !rows[j]) continue;
        rows[j].li.className = "";
        rows[j].st.textContent = "stopped";
      }
      state.clear();
      stopQuietTimer();
      settleLabel(`Stopped: ${finished} of ${count} done.`);
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
      stopQuietTimer();
      settleLabel(`Cancelled: ${finished} of ${count} done.`);
    },
    finish(text) {
      stopQuietTimer();
      bar.value = 100;
      settleLabel(text);
    },
  };
}
