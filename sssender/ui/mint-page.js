// Mint page for any app on sssender. <body data-root="app/"> names the app's upload
// root (required). The link opens the app in this directory
import { checkRoot, mintMagicLink } from "../core/mint.js?v=785d500";
import { normaliseEndpoint } from "../core/uploaders.js?v=785d500";
import { humanBytes, humanDate } from "./ui.js?v=785d500";

const $ = (id) => document.getElementById(id);
const root = checkRoot(document.body.dataset.root);
const val = (id) => $(id).value.trim();
const setError = (msg = "") => ($("mint-error").textContent = msg);

async function mint() {
  if (!globalThis.crypto?.subtle) {
    setError("Signing needs a secure page: open this over HTTPS or from localhost.");
    return;
  }
  const maxBytes = Math.floor(Number(val("max-gb")) * 1024 ** 3);
  try {
    const { link, prefix, expiresAt } = await mintMagicLink({
      endpoint: normaliseEndpoint($("server").value),
      bucket: val("bucket"),
      accessKeyId: val("access-key"),
      secretAccessKey: val("secret-key"),
      name: val("link-name"),
      root,
      days: Number(val("days")),
      maxBytes,
      baseUrl: new URL("./", location.href).href,
    });
    $("result-dest").textContent = `${val("bucket")}/${prefix.replace(/\/$/, "")}`;
    $("result-note").textContent = `Expires ${humanDate(expiresAt.getTime())}. Up to ${humanBytes(maxBytes)} per file.`;
    $("result-link").value = link;
    $("result").hidden = false;
    setError();
  } catch (err) {
    $("result").hidden = true;
    setError(err.message || String(err));
  }
}

$("mint-btn").addEventListener("click", mint);
$("copy-btn").addEventListener("click", () =>
  navigator.clipboard.writeText($("result-link").value).catch(() => $("result-link").select())
);
// A changed input makes the shown link stale
for (const el of document.querySelectorAll("#mint-form input")) {
  el.addEventListener("input", () => ($("result").hidden = true));
}
