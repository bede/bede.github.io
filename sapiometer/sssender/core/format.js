export function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function humanDate(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC");
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
