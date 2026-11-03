// Companion page for minting magic links in the browser, shared by updeacon-s3 and
// seq2bucket. <body data-raw="1"> puts uploads under raw/. The link opens the app in
// the same directory.
import { mintMagicLink } from "./mint.js?v=87dbf05";
import { humanBytes, humanDate } from "./ui.js?v=87dbf05";

const $ = (id) => document.getElementById(id);
const isRaw = document.body.dataset.raw === "1";
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
      endpoint: val("server"),
      bucket: val("bucket"),
      accessKeyId: val("access-key"),
      secretAccessKey: val("secret-key"),
      name: val("link-name"),
      raw: isRaw,
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
