import init, { run_lightfield as runLightfield } from "./pkg/lightfield_wasm.js";

const workerState = {
  initPromise: null,
  referenceBytes: null,
  primerBed: "",
  options: null,
};

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error("Expected bytes for worker initialization.");
}

function ensureInitialized() {
  if (!workerState.initPromise) {
    workerState.initPromise = init();
  }
  return workerState.initPromise;
}

function mergeByteArrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function mergeFiles(files) {
  const chunks = await Promise.all(
    files.map(async (file) => new Uint8Array(await file.arrayBuffer())),
  );
  return mergeByteArrays(chunks);
}

self.addEventListener("message", async (event) => {
  const message = event.data;

  try {
    if (message?.type === "init") {
      await ensureInitialized();
      workerState.referenceBytes = toUint8Array(message.referenceBytes);
      workerState.primerBed = message.primerBed;
      workerState.options = message.options;
      self.postMessage({ type: "ready" });
      return;
    }

    if (message?.type === "run") {
      if (!workerState.referenceBytes || !workerState.options) {
        throw new Error("Worker received a run request before initialization.");
      }

      const options = workerState.options;
      const readsBytes = await mergeFiles(message.files || []);
      const result = runLightfield(
        message.sampleName,
        readsBytes,
        workerState.referenceBytes,
        workerState.primerBed,
        options.minDepth,
        options.minAmbigFreq,
        options.minAmbigDepth,
        options.minVarFreq,
        options.iupac,
        options.normaliseDepth,
      );

      self.postMessage({
        type: "result",
        requestId: message.requestId,
        result,
      });
      return;
    }

    throw new Error(`Unknown worker message type: ${message?.type ?? "<missing>"}`);
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: message?.requestId ?? null,
      error: describeError(error),
    });
  }
});
