const textEncoder = new TextEncoder();
const DEFAULT_MIN_AMBIG_FREQ = 0.2;
const DEFAULT_MIN_AMBIG_DEPTH = 10;
const DEFAULT_MIN_VAR_FREQ = 0.8;
const DEFAULT_IUPAC = false;
const MAX_BATCH_WORKERS = 8;

const els = {
  form: document.querySelector("#run-form"),
  status: document.querySelector("#status"),
  readsField: {
    zone: document.querySelector("#reads-zone"),
    fileInput: document.querySelector("#reads-file"),
    dirInput: document.querySelector("#reads-dir"),
    fileButton: document.querySelector("#reads-file-button"),
    dirButton: document.querySelector("#reads-dir-button"),
    name: document.querySelector("#reads-name"),
    meta: document.querySelector("#reads-meta"),
  },
  schemeField: {
    zone: document.querySelector("#scheme-zone"),
    input: document.querySelector("#scheme"),
    button: document.querySelector("#scheme-button"),
    name: document.querySelector("#scheme-name"),
    meta: document.querySelector("#scheme-meta"),
  },
  sheetField: {
    zone: document.querySelector("#sheet-zone"),
    input: document.querySelector("#sheet"),
    button: document.querySelector("#sheet-button"),
    name: document.querySelector("#sheet-name"),
    meta: document.querySelector("#sheet-meta"),
  },
  minDepth: document.querySelector("#min-depth"),
  normaliseDepth: document.querySelector("#normalise-depth"),
  runButton: document.querySelector("#run-button"),
  resetButton: document.querySelector("#reset-button"),
  summaryPanel: document.querySelector("#summary-panel"),
  summary: document.querySelector("#summary"),
  downloads: document.querySelector("#downloads"),
  resultsWrap: document.querySelector("#results-wrap"),
  resultsBody: document.querySelector("#results-body"),
};

const state = {
  reads: null,
  primerScheme: null,
  sampleSheetFile: null,
  results: [],
};

let runLightfield = null;

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.className = isError ? "status error" : "status";
}

function baseName(filename) {
  return filename.replace(/\.(fastq|fq|fasta|fa)(\.gz)?$/i, "") || "sample";
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatCount(value) {
  return value.toLocaleString();
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function pathParts(path) {
  return path.split("/").filter(Boolean);
}

function isReadsPath(path) {
  return /\.(fastq|fq|fasta|fa)(\.gz)?$/i.test(path);
}

function normalizePathText(value) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function lastPathComponent(value) {
  const parts = normalizePathText(value).split("/").filter(Boolean);
  return parts.at(-1) || "";
}

function fileRecord(file, path = file.webkitRelativePath || file.name) {
  return {
    file,
    path: path.replace(/\\/g, "/"),
  };
}

function assignInputFiles(input, files) {
  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(file);
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function syncNamedField(field, loaded, name = "", meta = "") {
  field.zone.classList.toggle("loaded", loaded);
  field.name.textContent = loaded ? name : "";
  field.meta.textContent = meta;
}

function syncReadsField() {
  if (!state.reads) {
    syncNamedField(els.readsField, false, "", "");
    return;
  }

  if (state.reads.mode === "single") {
    syncNamedField(
      els.readsField,
      true,
      state.reads.file.name,
      formatBytes(state.reads.file.size),
    );
    return;
  }

  syncNamedField(
    els.readsField,
    true,
    `${state.reads.rootName}/`,
    `${state.reads.sampleCount} samples, ${state.reads.fileCount} files`,
  );
}

function syncSchemeField() {
  syncNamedField(
    els.schemeField,
    Boolean(state.primerScheme),
    state.primerScheme ? `${state.primerScheme.name}/` : "",
    state.primerScheme ? "Directory loaded" : "",
  );
}

function syncSheetField() {
  syncNamedField(
    els.sheetField,
    Boolean(state.sampleSheetFile),
    state.sampleSheetFile ? state.sampleSheetFile.name : "",
    state.sampleSheetFile ? "CSV loaded" : "",
  );
}

function renderSummary(rows) {
  els.summary.innerHTML = "";
  for (const [label, value] of rows) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<dt>${label}</dt><dd>${value}</dd>`;
    els.summary.appendChild(wrapper);
  }
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadText(filename, text) {
  downloadBlob(filename, new Blob([text], { type: "text/plain;charset=utf-8" }));
}

async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

async function mergeByteArrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function getOptions() {
  return {
    minDepth: Number(els.minDepth.value),
    minAmbigFreq: DEFAULT_MIN_AMBIG_FREQ,
    minAmbigDepth: DEFAULT_MIN_AMBIG_DEPTH,
    minVarFreq: DEFAULT_MIN_VAR_FREQ,
    iupac: DEFAULT_IUPAC,
    normaliseDepth: Number(els.normaliseDepth.value),
  };
}

function validateOptions(options) {
  if (!(options.minVarFreq > options.minAmbigFreq)) {
    throw new Error("Min var freq must be greater than min ambig freq.");
  }
}

function determineBatchWorkerCount(sampleCount) {
  const reported = Number(navigator.hardwareConcurrency) || 4;
  return Math.min(sampleCount, Math.max(1, Math.min(MAX_BATCH_WORKERS, reported)));
}

function buildBatchProgressMessage(completed, total, workerCount) {
  return `Running ${completed}/${total} sample(s) with ${workerCount} worker${workerCount === 1 ? "" : "s"}…`;
}

function createBatchWorker(referenceBytes, primerBed, options) {
  return new Promise((resolve, reject) => {
    let ready = false;
    let closed = false;
    let nextRequestId = 1;
    const pending = new Map();
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

    const rejectPending = (error) => {
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
    };

    const fail = (error) => {
      if (!closed) {
        closed = true;
        worker.terminate();
      }
      rejectPending(error);
      if (!ready) {
        reject(error);
      }
    };

    worker.addEventListener("message", (event) => {
      const message = event.data;

      if (message?.type === "ready") {
        ready = true;
        resolve({
          runSample(sample) {
            return new Promise((resolveRun, rejectRun) => {
              const requestId = nextRequestId;
              nextRequestId += 1;
              pending.set(requestId, { resolve: resolveRun, reject: rejectRun });
              worker.postMessage({
                type: "run",
                requestId,
                sampleName: sample.sampleName,
                files: sample.records.map((record) => record.file),
              });
            });
          },
          terminate(error = new Error("Worker terminated.")) {
            closed = true;
            rejectPending(error);
            worker.terminate();
          },
        });
        return;
      }

      if (message?.type === "result") {
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        request.resolve(message.result);
        return;
      }

      if (message?.type === "error") {
        const error = new Error(message.error || "Worker failed.");
        if (message.requestId == null) {
          fail(error);
          return;
        }

        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        request.reject(error);
      }
    });

    worker.addEventListener("error", (event) => {
      fail(event.error instanceof Error ? event.error : new Error(event.message || "Worker failed."));
    });

    worker.postMessage({
      type: "init",
      referenceBytes,
      primerBed,
      options,
    });
  });
}

async function runBatchOnMainThread(samples, reference, primerBed, options) {
  const workerCount = 1;
  setStatus(buildBatchProgressMessage(0, samples.length, workerCount));

  const results = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const readsBytes = await mergeByteArrays(
      await Promise.all(sample.records.map((record) => readBytes(record.file))),
    );

    results.push(
      runLightfield(
        sample.sampleName,
        readsBytes,
        reference,
        primerBed,
        options.minDepth,
        options.minAmbigFreq,
        options.minAmbigDepth,
        options.minVarFreq,
        options.iupac,
        options.normaliseDepth,
      ),
    );

    setStatus(buildBatchProgressMessage(index + 1, samples.length, workerCount));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  results.sort((left, right) => left.sample_name.localeCompare(right.sample_name));
  return results;
}

async function runBatchWithWorkers(samples, reference, primerBed, options) {
  if (typeof Worker !== "function") {
    return runBatchOnMainThread(samples, reference, primerBed, options);
  }

  const workerCount = determineBatchWorkerCount(samples.length);
  setStatus(buildBatchProgressMessage(0, samples.length, workerCount));

  const workers = [];
  try {
    for (let index = 0; index < workerCount; index += 1) {
      workers.push(await createBatchWorker(reference, primerBed, options));
    }
  } catch (error) {
    for (const workerHandle of workers) {
      workerHandle.terminate(error);
    }
    throw error;
  }

  const results = [];
  let completed = 0;
  let nextIndex = 0;

  const runQueue = async (workerHandle) => {
    while (nextIndex < samples.length) {
      const sample = samples[nextIndex];
      nextIndex += 1;

      const result = await workerHandle.runSample(sample);
      results.push(result);
      completed += 1;
      setStatus(buildBatchProgressMessage(completed, samples.length, workerCount));
    }
  };

  try {
    await Promise.all(workers.map((workerHandle) => runQueue(workerHandle)));
  } finally {
    for (const workerHandle of workers) {
      workerHandle.terminate();
    }
  }

  results.sort((left, right) => left.sample_name.localeCompare(right.sample_name));
  return results;
}

async function loadWasmModule() {
  const candidates = [
    { path: "./pkg/lightfield_wasm.js", exportName: "run_lightfield" },
    { path: "./pkg/lightfield_wasm.js", exportName: "run_lightfield", legacy: true },
  ];

  let lastError = null;

  for (const candidate of candidates) {
    try {
      const wasmModule = await import(candidate.path);
      const init = wasmModule.default;
      const run = wasmModule[candidate.exportName];

      if (typeof init !== "function") {
        throw new Error(`Missing default init export in ${candidate.path}`);
      }

      if (typeof run !== "function") {
        throw new Error(`Missing ${candidate.exportName} export in ${candidate.path}`);
      }

      await init();

      if (candidate.legacy) {
        console.warn("Loaded legacy lightfield-wasm package; rebuild lightfield-wasm/pkg when convenient.");
      }

      return run;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("No wasm package could be loaded.");
}

async function readAllDirectoryEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

async function readDroppedEntry(entry, parentPath = "") {
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    return [fileRecord(file, currentPath)];
  }

  if (!entry.isDirectory) {
    return [];
  }

  const reader = entry.createReader();
  const children = await readAllDirectoryEntries(reader);
  const nested = await Promise.all(children.map((child) => readDroppedEntry(child, currentPath)));
  return nested.flat();
}

async function readDroppedRecords(items) {
  const records = await Promise.all(
    Array.from(items).map(async (item) => {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        return readDroppedEntry(entry);
      }

      const file = item.getAsFile?.();
      return file ? [fileRecord(file)] : [];
    }),
  );

  return records.flat();
}

function resolvePrimerScheme(records) {
  if (!records.length) {
    throw new Error("No files found in the selected primer scheme directory.");
  }

  const schemeRoots = [...new Set(records.map((record) => pathParts(record.path)[0]).filter(Boolean))];
  if (schemeRoots.length !== 1) {
    throw new Error("Select a single primer scheme directory.");
  }

  const schemeName = schemeRoots[0];
  const rootFiles = records.filter((record) => {
    const parts = pathParts(record.path);
    return parts.length === 2 && parts[0] === schemeName;
  });

  const referenceMatches = rootFiles.filter(
    (record) => pathParts(record.path)[1].toLowerCase() === "reference.fasta",
  );
  const primerMatches = rootFiles.filter(
    (record) => pathParts(record.path)[1].toLowerCase() === "primer.bed",
  );

  if (referenceMatches.length !== 1 || primerMatches.length !== 1) {
    throw new Error("Primer scheme directory must contain root-level reference.fasta and primer.bed files.");
  }

  return {
    name: schemeName,
    reference: referenceMatches[0],
    primers: primerMatches[0],
  };
}

function buildBatchReads(records) {
  const readRecords = records.filter((record) => isReadsPath(record.path));
  if (!readRecords.length) {
    throw new Error("No FASTQ/FASTA files were found in the selected reads directory.");
  }

  const roots = [...new Set(readRecords.map((record) => pathParts(record.path)[0]).filter(Boolean))];
  if (roots.length !== 1) {
    throw new Error("Select a single reads directory.");
  }

  const rootName = roots[0];
  let sawDirectories = false;
  let sawRootFiles = false;
  const grouped = new Map();

  for (const record of readRecords) {
    const parts = pathParts(record.path);
    const hasSubdirectory = parts.length >= 3;
    sawDirectories ||= hasSubdirectory;
    sawRootFiles ||= !hasSubdirectory;

    const sourceName = hasSubdirectory ? parts[1] : baseName(parts.at(-1) || record.file.name);
    const existing = grouped.get(sourceName) || {
      sourceName,
      records: [],
      matchCandidates: new Set([sourceName, `${rootName}/${sourceName}`]),
    };

    existing.records.push(record);
    existing.matchCandidates.add(normalizePathText(record.path));
    existing.matchCandidates.add(record.file.name);
    if (hasSubdirectory) {
      existing.matchCandidates.add(`${sourceName}/${record.file.name}`);
      existing.matchCandidates.add(`${rootName}/${sourceName}/${record.file.name}`);
    } else {
      existing.matchCandidates.add(`${rootName}/${record.file.name}`);
    }

    grouped.set(sourceName, existing);
  }

  if (sawDirectories && sawRootFiles) {
    throw new Error("Reads directory must contain either sample subdirectories or reads files at the root, not both.");
  }

  const samples = [...grouped.values()]
    .map((sample) => ({
      ...sample,
      records: sample.records.sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .sort((left, right) => left.sourceName.localeCompare(right.sourceName));

  return {
    mode: "batch",
    rootName,
    samples,
    sampleCount: samples.length,
    fileCount: readRecords.length,
  };
}

function buildDroppedReadsSelection(records) {
  const readRecords = records.filter((record) => isReadsPath(record.path));
  if (!readRecords.length) {
    throw new Error("No FASTQ/FASTA reads were found in the drop.");
  }

  if (readRecords.length === 1 && pathParts(readRecords[0].path).length <= 1) {
    return {
      mode: "single",
      file: readRecords[0].file,
    };
  }

  return buildBatchReads(records);
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function parseSampleSheet(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    throw new Error("Sample sheet must contain a header and at least one row.");
  }

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const sampleIndex = headers.indexOf("sample");
  const fastqDirectoryIndex = headers.indexOf("fastq_directory");
  const fastq1Index = headers.indexOf("fastq_1");

  if (sampleIndex === -1) {
    throw new Error("Sample sheet is missing a 'sample' column.");
  }

  if (fastqDirectoryIndex === -1 && fastq1Index === -1) {
    throw new Error("Sample sheet must include 'fastq_directory' or 'fastq_1'.");
  }

  return rows.slice(1).flatMap((row, index) => {
    const sample = (row[sampleIndex] || "").trim();
    const fastqDirectory = normalizePathText(row[fastqDirectoryIndex] || "");
    const fastq1 = normalizePathText(row[fastq1Index] || "");

    if (!sample && !fastqDirectory && !fastq1) {
      return [];
    }

    if (!sample) {
      throw new Error(`Sample sheet row ${index + 2} has an empty sample name.`);
    }

    if (!fastqDirectory && !fastq1) {
      throw new Error(`Sample sheet row ${index + 2} must include 'fastq_directory' or 'fastq_1'.`);
    }

    return [{ sample, fastqDirectory, fastq1 }];
  });
}

function sampleMatchesPath(sample, value) {
  const normalized = normalizePathText(value);
  if (!normalized) {
    return false;
  }

  if (sample.matchCandidates.has(normalized)) {
    return true;
  }

  const basename = lastPathComponent(normalized);
  return basename ? sample.matchCandidates.has(basename) : false;
}

function applySampleSheetToBatch(samples, sheetText) {
  const entries = parseSampleSheet(sheetText);
  const usedNames = new Set();

  return samples
    .map((sample) => {
      const matches = entries.filter(
        (entry) =>
          (entry.fastqDirectory && sampleMatchesPath(sample, entry.fastqDirectory)) ||
          (entry.fastq1 && sampleMatchesPath(sample, entry.fastq1)),
      );

      if (!matches.length) {
        throw new Error(`Sample sheet did not contain a mapping for ${sample.sourceName}.`);
      }

      if (matches.length > 1) {
        throw new Error(`Sample sheet matched ${sample.sourceName} more than once.`);
      }

      const sampleName = matches[0].sample;
      if (usedNames.has(sampleName)) {
        throw new Error(`Sample sheet maps multiple inputs to '${sampleName}'.`);
      }
      usedNames.add(sampleName);

      return {
        ...sample,
        sampleName,
      };
    })
    .sort((left, right) => left.sampleName.localeCompare(right.sampleName));
}

function clearResults() {
  state.results = [];
  els.summary.innerHTML = "";
  els.downloads.innerHTML = "";
  els.resultsBody.innerHTML = "";
  els.resultsWrap.hidden = true;
  els.summaryPanel.hidden = true;
}

function renderManyResults(results) {
  els.resultsBody.innerHTML = "";

  for (const result of results) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${result.sample_name}</td>
      <td>${formatCount(result.reads)}</td>
      <td>${formatCount(result.mapped_reads)}</td>
      <td>${result.coverage_percent.toFixed(1)}%</td>
      <td>${result.variant_count}</td>
      <td></td>
    `;

    const downloadsCell = row.lastElementChild;
    const fastaButton = document.createElement("button");
    fastaButton.type = "button";
    fastaButton.className = "table-button";
    fastaButton.textContent = "FASTA";
    fastaButton.addEventListener("click", () => {
      downloadText(`${result.sample_name}.consensus.fasta`, result.consensus_fasta);
    });

    const vcfButton = document.createElement("button");
    vcfButton.type = "button";
    vcfButton.className = "table-button";
    vcfButton.textContent = "VCF";
    vcfButton.addEventListener("click", () => {
      downloadText(`${result.sample_name}.vcf`, result.vcf);
    });

    downloadsCell.append(fastaButton, vcfButton);
    els.resultsBody.appendChild(row);
  }

  els.resultsWrap.hidden = false;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipBlob(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, file.bytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + size;
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, endRecord], { type: "application/zip" });
}

function renderResults(results) {
  state.results = results;
  els.summaryPanel.hidden = false;
  els.downloads.innerHTML = "";
  els.resultsBody.innerHTML = "";
  els.resultsWrap.hidden = true;

  if (results.length === 1) {
    const result = results[0];
    renderSummary([
      ["Sample", result.sample_name],
      ["Reference", result.reference_name],
      ["Reads", formatCount(result.reads)],
      ["Mapped", formatCount(result.mapped_reads)],
      ["Coverage", `${result.coverage_percent.toFixed(1)}%`],
      ["Variants", String(result.variant_count)],
    ]);

    const fastaButton = document.createElement("button");
    fastaButton.type = "button";
    fastaButton.textContent = "Download FASTA";
    fastaButton.addEventListener("click", () => {
      downloadText(`${result.sample_name}.consensus.fasta`, result.consensus_fasta);
    });

    const vcfButton = document.createElement("button");
    vcfButton.type = "button";
    vcfButton.textContent = "Download VCF";
    vcfButton.addEventListener("click", () => {
      downloadText(`${result.sample_name}.vcf`, result.vcf);
    });

    els.downloads.append(fastaButton, vcfButton);
    return;
  }

  const totalReads = results.reduce((sum, result) => sum + result.reads, 0);
  const totalMapped = results.reduce((sum, result) => sum + result.mapped_reads, 0);
  const totalVariants = results.reduce((sum, result) => sum + result.variant_count, 0);
  const averageCoverage =
    results.reduce((sum, result) => sum + result.coverage_percent, 0) / Math.max(results.length, 1);

  renderSummary([
    ["Samples", String(results.length)],
    ["Reads", formatCount(totalReads)],
    ["Mapped", formatCount(totalMapped)],
    ["Mean coverage", `${averageCoverage.toFixed(1)}%`],
    ["Variants", formatCount(totalVariants)],
  ]);

  const zipButton = document.createElement("button");
  zipButton.type = "button";
  zipButton.textContent = "Download ZIP";
  zipButton.addEventListener("click", () => {
    const files = [];
    for (const result of results) {
      files.push({
        name: `${result.sample_name}.consensus.fasta`,
        bytes: textEncoder.encode(result.consensus_fasta),
      });
      files.push({
        name: `${result.sample_name}.vcf`,
        bytes: textEncoder.encode(result.vcf),
      });
    }
    downloadBlob("lightfield-results.zip", createZipBlob(files));
  });

  els.downloads.appendChild(zipButton);
  renderManyResults(results);
}

function resetState() {
  els.readsField.fileInput.value = "";
  els.readsField.dirInput.value = "";
  els.schemeField.input.value = "";
  els.sheetField.input.value = "";
  els.minDepth.value = "20";
  els.normaliseDepth.value = "1000";
  state.reads = null;
  state.primerScheme = null;
  state.sampleSheetFile = null;
  clearResults();
  syncReadsField();
  syncSchemeField();
  syncSheetField();
  setStatus("Ready");
}

function activateDropZone(zone) {
  zone.classList.add("dragover");
}

function deactivateDropZone(zone) {
  zone.classList.remove("dragover");
}

function setupDropZone(zone, onDrop, onError) {
  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    activateDropZone(zone);
  });

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    activateDropZone(zone);
  });

  zone.addEventListener("dragleave", (event) => {
    if (event.target === zone) {
      deactivateDropZone(zone);
    }
  });

  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    deactivateDropZone(zone);
    try {
      await onDrop(event);
    } catch (error) {
      console.error(error);
      onError(error);
    }
  });
}

function setSingleReads(file) {
  state.reads = {
    mode: "single",
    file,
  };
  els.readsField.dirInput.value = "";
  syncReadsField();
}

function setBatchReads(records) {
  state.reads = buildBatchReads(records);
  els.readsField.fileInput.value = "";
  syncReadsField();
}

els.readsField.fileButton.addEventListener("click", () => {
  els.readsField.fileInput.click();
});

els.readsField.dirButton.addEventListener("click", () => {
  els.readsField.dirInput.click();
});

els.schemeField.button.addEventListener("click", () => {
  els.schemeField.input.click();
});

els.sheetField.button.addEventListener("click", () => {
  els.sheetField.input.click();
});

els.readsField.fileInput.addEventListener("change", () => {
  const file = els.readsField.fileInput.files?.[0];
  if (!file) return;
  setSingleReads(file);
  setStatus("Loaded reads file");
});

els.readsField.dirInput.addEventListener("change", () => {
  const records = Array.from(els.readsField.dirInput.files || []).map((file) => fileRecord(file));
  try {
    setBatchReads(records);
    setStatus(`Loaded ${state.reads.sampleCount} batch sample(s)`);
  } catch (error) {
    console.error(error);
    state.reads = null;
    syncReadsField();
    setStatus(`Reads load failed: ${describeError(error)}`, true);
  }
});

els.schemeField.input.addEventListener("change", () => {
  try {
    const records = Array.from(els.schemeField.input.files || []).map((file) => fileRecord(file));
    state.primerScheme = resolvePrimerScheme(records);
    syncSchemeField();
    setStatus(`Loaded primer scheme: ${state.primerScheme.name}`);
  } catch (error) {
    console.error(error);
    state.primerScheme = null;
    syncSchemeField();
    setStatus(`Primer scheme load failed: ${describeError(error)}`, true);
  }
});

els.sheetField.input.addEventListener("change", () => {
  state.sampleSheetFile = els.sheetField.input.files?.[0] || null;
  syncSheetField();
});

setupDropZone(
  els.readsField.zone,
  async (event) => {
    const records = await readDroppedRecords(event.dataTransfer?.items || []);
    const selection = buildDroppedReadsSelection(records);

    if (selection.mode === "single") {
      assignInputFiles(els.readsField.fileInput, [selection.file]);
      return;
    }

    state.reads = selection;
    els.readsField.fileInput.value = "";
    els.readsField.dirInput.value = "";
    syncReadsField();
    setStatus(`Loaded ${state.reads.sampleCount} batch sample(s)`);
  },
  (error) => setStatus(`Reads load failed: ${describeError(error)}`, true),
);

setupDropZone(
  els.schemeField.zone,
  async (event) => {
    const records = await readDroppedRecords(event.dataTransfer?.items || []);
    state.primerScheme = resolvePrimerScheme(records);
    els.schemeField.input.value = "";
    syncSchemeField();
    setStatus(`Loaded primer scheme: ${state.primerScheme.name}`);
  },
  (error) => setStatus(`Primer scheme load failed: ${describeError(error)}`, true),
);

setupDropZone(
  els.sheetField.zone,
  async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    assignInputFiles(els.sheetField.input, [file]);
  },
  (error) => setStatus(`Sample sheet load failed: ${describeError(error)}`, true),
);

els.resetButton.addEventListener("click", () => {
  resetState();
});

const wasmReady = loadWasmModule()
  .then((run) => {
    runLightfield = run;
    setStatus("Ready");
  })
  .catch((error) => {
    console.error(error);
    setStatus(`Failed to load wasm: ${describeError(error)}`, true);
    throw error;
  });

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await wasmReady;

  if (!state.reads || !state.primerScheme) {
    setStatus("Load reads plus a primer scheme directory before running.", true);
    return;
  }

  const options = getOptions();
  try {
    validateOptions(options);
  } catch (error) {
    setStatus(describeError(error), true);
    return;
  }

  els.runButton.disabled = true;
  els.resetButton.disabled = true;
  clearResults();

  try {
    const [reference, primerBed, sheetText] = await Promise.all([
      readBytes(state.primerScheme.reference.file),
      state.primerScheme.primers.file.text(),
      state.sampleSheetFile ? state.sampleSheetFile.text() : Promise.resolve(null),
    ]);

    let results;

    if (state.reads.mode === "single") {
      setStatus("Running sample…");
      const reads = await readBytes(state.reads.file);
      results = [
        runLightfield(
          baseName(state.reads.file.name),
          reads,
          reference,
          primerBed,
          options.minDepth,
          options.minAmbigFreq,
          options.minAmbigDepth,
          options.minVarFreq,
          options.iupac,
          options.normaliseDepth,
        ),
      ];
    } else {
      let samples = state.reads.samples.map((sample) => ({
        ...sample,
        sampleName: sample.sourceName,
      }));

      if (sheetText) {
        samples = applySampleSheetToBatch(samples, sheetText);
      }

      results = await runBatchWithWorkers(samples, reference, primerBed, options);
    }

    renderResults(results);
    setStatus(`Finished ${results.length} sample(s)`);
  } catch (error) {
    console.error(error);
    clearResults();
    setStatus(`Run failed: ${describeError(error)}`, true);
  } finally {
    els.runButton.disabled = false;
    els.resetButton.disabled = false;
  }
});

clearResults();
syncReadsField();
syncSchemeField();
syncSheetField();
