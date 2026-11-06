// File selection, independent of UI: drop junk, type files (switchable), group them.
// A group is what a transform consumes and what fails together: { label, size, files }.
// sssender groups each file alone. Apps may group otherwise (updeacon pairs R1/R2).

export const relativePath = (file) => file.webkitRelativePath || file.name;

const basename = (path) => path.slice(path.lastIndexOf("/") + 1);

// Compression belongs to the type beneath it: x.fastq.gz is fastq.gz
const COMPRESSION = new Set(["gz", "bz2", "xz", "zst", "lz4", "br"]);

// OS litter and anything in a hidden directory is never uploaded
const JUNK_NAMES = new Set(["thumbs.db", "desktop.ini", "icon\r"]);

export function isJunk(file) {
  const parts = relativePath(file).split("/");
  return parts.some((p) => p.startsWith(".")) || JUNK_NAMES.has(parts.at(-1).toLowerCase());
}

// Lower-case extension, compression kept: "a.FASTQ.gz" -> "fastq.gz", "README" -> ""
export function fileType(file) {
  const parts = basename(typeof file === "string" ? file : file.name).toLowerCase().split(".");
  if (parts.length < 2 || (parts.length === 2 && !parts[0])) return "";
  const last = parts.at(-1);
  if (COMPRESSION.has(last) && parts.length > 2) return `${parts.at(-2)}.${last}`;
  return last;
}

export function describeType(key) {
  return key ? `.${key}` : "no extension";
}

const byLabel = (a, b) => a.label.localeCompare(b.label);

export function singleGroups(files) {
  return files
    .map((file) => ({ label: relativePath(file), size: file.size || 0, files: [file] }))
    .sort(byLabel);
}

// Selection -> what will be uploaded. Never throws: a grouping error comes back as `error`.
//   accept(file)     files that count at all (default: all)
//   classify(file)   type for switching on/off (default: fileType)
//   group(files)     -> groups (default: singleGroups), may throw
//   disabled         Set of types switched off
// -> { files, selected, types, ignored, rejected, groups, totalBytes, error }
//   files      accepted
//   selected   accepted, of enabled types
//   types      [{ key, count, bytes, enabled }]
//   ignored    junk
//   rejected   refused by accept()
export function selectFiles(
  input,
  { accept = () => true, classify = fileType, group = singleGroups, disabled = new Set() } = {}
) {
  let ignored = 0;
  let rejected = 0;
  const files = [];
  for (const file of input) {
    if (isJunk(file)) ignored++;
    else if (!accept(file)) rejected++;
    else files.push(file);
  }

  const byType = new Map();
  for (const file of files) {
    const key = classify(file);
    const t = byType.get(key) || { key, count: 0, bytes: 0, enabled: !disabled.has(key) };
    t.count++;
    t.bytes += file.size || 0;
    byType.set(key, t);
  }
  const types = [...byType.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const selected = files.filter((f) => !disabled.has(classify(f)));

  let groups = [];
  let error = null;
  try {
    groups = selected.length ? group(selected) : [];
  } catch (err) {
    error = err?.message || String(err);
  }
  const totalBytes = groups.reduce((n, g) => n + g.size, 0);
  return { files, selected, types, ignored, rejected, groups, totalBytes, error };
}
