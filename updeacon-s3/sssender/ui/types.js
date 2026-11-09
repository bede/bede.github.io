// One toggle per file type, shown when a selection has several. onToggle(key):
// the page reselects (selectFiles with `disabled`) and re-renders
import { describeType } from "../core/select.js?v=6684013";
import { humanBytes } from "./ui.js?v=6684013";

export function renderTypeToggles(el, types, { onToggle, disabled = false }) {
  el.replaceChildren();
  el.hidden = types.length < 2;
  if (el.hidden) return;
  for (const t of types) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "type-toggle";
    btn.disabled = disabled;
    btn.setAttribute("aria-pressed", String(t.enabled));
    btn.textContent = `${describeType(t.key)} ×${t.count}`;
    btn.title =
      `${t.count} file${t.count === 1 ? "" : "s"}, ${humanBytes(t.bytes)}. ` +
      `Click to ${t.enabled ? "leave these out" : "include them"}.`;
    btn.addEventListener("click", () => onToggle(t.key));
    el.append(btn);
  }
}
