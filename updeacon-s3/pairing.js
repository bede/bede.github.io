export const SEQ_RE = /\.(fastq|fq|fasta|fa)(\.gz)?$/i;

const MATE_PATTERNS = [
  /(^|[._-])R([12])(?=([._-]|$))/i,
  /(^|[._-])([12])$/,
];

function relativePath(file) {
  return file.webkitRelativePath || file.name;
}

function splitPath(path) {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: path };
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

function stripSeqExt(name) {
  return name.replace(SEQ_RE, "");
}

function mateInfo(file) {
  const rel = relativePath(file);
  const { dir, name } = splitPath(rel);
  const stem = stripSeqExt(name);

  for (const pattern of MATE_PATTERNS) {
    const match = pattern.exec(stem);
    if (!match) continue;
    const mate = match[2] === "1" ? "r1" : "r2";
    const keyStem =
      stem.slice(0, match.index + match[1].length) + "{mate}" + stem.slice(match.index + match[0].length);
    return {
      mate,
      key: `${dir}/${keyStem}`.replace(/^\//, ""),
      dir,
    };
  }
  return null;
}

export function pairSequenceFiles(files) {
  const seqs = files.filter((file) => SEQ_RE.test(file.name));
  const pairBuckets = new Map();
  const singles = [];

  for (const file of seqs) {
    const info = mateInfo(file);
    if (!info) {
      singles.push(file);
      continue;
    }
    const bucket = pairBuckets.get(info.key) || { r1: [], r2: [] };
    bucket[info.mate].push(file);
    pairBuckets.set(info.key, bucket);
  }

  const groups = singles.map((file) => ({
    kind: "single",
    file,
    label: relativePath(file),
    size: file.size || 0,
  }));

  for (const [key, bucket] of pairBuckets) {
    if (bucket.r1.length !== 1 || bucket.r2.length !== 1) {
      const seen = [...bucket.r1, ...bucket.r2].map(relativePath).join(", ");
      throw new Error(`Ambiguous or incomplete pair for ${key}: ${seen || "no files"}`);
    }
    const file1 = bucket.r1[0];
    const file2 = bucket.r2[0];
    groups.push({
      kind: "paired",
      file1,
      file2,
      label: `${relativePath(file1)} & ${relativePath(file2)}`,
      size: (file1.size || 0) + (file2.size || 0),
    });
  }

  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

export function groupRelativePaths(group) {
  if (group.kind === "paired") {
    return {
      input: relativePath(group.file1),
      input2: relativePath(group.file2),
    };
  }
  return {
    input: relativePath(group.file),
    input2: null,
  };
}
