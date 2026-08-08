// Sender: turn a file into an endless chunked fountain-coded QR stream.
// Supports arbitrarily large files (e.g. 50MB+) with chunked LT coding.

import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { HEADER_LEN, compressPayload, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 12;
const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk for high-speed parallel fountain streaming

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;
const cfgFileLabel = document.getElementById("cfg-file-label") as HTMLLabelElement;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;

let generation = 0; // bumped on every restart; stale loops see it and die
let customPayload: Uint8Array | null = null;
let customFileName = "";

async function main() {
  if (cfgFileLabel) {
    cfgFileLabel.style.display = "flex";
  }

  cfgFile.addEventListener("change", async () => {
    const file = cfgFile.files?.[0];
    if (file) {
      try {
        const buf = await file.arrayBuffer();
        customPayload = new Uint8Array(buf);
        customFileName = file.name;
        void startStream();
      } catch (err) {
        specs.textContent = `✗ gagal membaca file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  });

  for (const el of [cfgFps, cfgBytes, cfgEcc, cfgSize]) {
    el?.addEventListener("change", () => void startStream());
  }
  await startStream();
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine without it */
  }
}

async function startStream() {
  const gen = ++generation;
  let payloadLabel = "";

  if (!customPayload) {
    specs.textContent = `📁 Silakan pilih file yang ingin dikirim melalui tombol "Pilih File" di bawah`;
    return;
  }

  const fullFnv = fnv1a(customPayload);
  const { bytes: encodedPayload, compressed } = await compressPayload(customPayload);

  payloadLabel = compressed
    ? `${customFileName} (${Math.round(customPayload.length / 1024)} KB ⚡ GZIP ${Math.round(encodedPayload.length / 1024)} KB)`
    : `${customFileName} (${Math.round(customPayload.length / 1024)} KB)`;

  if (gen !== generation) return; // superseded while fetching
  const txFps = cfgFps ? Number(cfgFps.value) : 60;
  const frameBytes = cfgBytes ? Number(cfgBytes.value) : 320;
  const ecc = cfgEcc ? (cfgEcc.value as "L" | "M" | "Q" | "H") : "L";
  const displayPx = cfgSize ? Number(cfgSize.value) : 700;

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = frameBytes - HEADER_LEN;
  const totalChunks = Math.max(1, Math.ceil(encodedPayload.length / CHUNK_SIZE));

  const chunkEncoders: LTEncoder[] = [];
  const chunkNextSeq: number[] = new Array(totalChunks).fill(0);

  for (let c = 0; c < totalChunks; c++) {
    const chunkBytes = encodedPayload.subarray(c * CHUNK_SIZE, Math.min((c + 1) * CHUNK_SIZE, encodedPayload.length));
    chunkEncoders.push(new LTEncoder(chunkBytes, blockLen, (sessionId + c * 997) & 0xffff));
  }

  let currentChunkIdx = 0;
  let chunkFramesEmitted = 0;
  // Pure 1-frame round-robin chunk interleaving for smooth parallel reception
  const framesPerBatch = (_c: number) => 1;

  let version: number | undefined; // locked after the first frame
  let modules = 0;
  let scale = 1;
  const queue: ImageData[] = [];

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };

  const makeFrame = (): ImageData => {
    const enc = chunkEncoders[currentChunkIdx]!;
    const seq = chunkNextSeq[currentChunkIdx]!++;
    const header: FrameHeader = {
      sessionId,
      seq,
      k: enc.k,
      blockLen,
      totalLen: encodedPayload.length,
      payloadFnv: fullFnv,
      chunkIdx: currentChunkIdx,
      totalChunks,
      compressed,
    };

    const bytes = packFrame(header, enc.encode(seq));

    chunkFramesEmitted++;
    if (chunkFramesEmitted >= framesPerBatch(currentChunkIdx)) {
      chunkFramesEmitted = 0;
      currentChunkIdx = (currentChunkIdx + 1) % totalChunks;
    }

    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });

    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
    }

    specs.textContent =
      `${txFps} FPS · ${frameBytes} B/frame · V${version} · ECC ${ecc} · ` +
      `${payloadLabel} · Chunk ${currentChunkIdx + 1}/${totalChunks}`;

    const size = qr.modules.size;
    const data = qr.modules.data;
    const total = size + 2 * MARGIN;
    const canvasWidth = total * scale;
    const img = new ImageData(canvasWidth, canvasWidth);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < size; y++) {
      const startY = (y + MARGIN) * scale;
      const src = y * size;
      for (let x = 0; x < size; x++) {
        if (data[src + x]) {
          const startX = (x + MARGIN) * scale;
          for (let sy = 0; sy < scale; sy++) {
            const rowOffset = (startY + sy) * canvasWidth;
            for (let sx = 0; sx < scale; sx++) {
              px[rowOffset + startX + sx] = 0xff000000;
            }
          }
        }
      }
    }
    return img;
  };

  const pump = () => {
    if (gen !== generation) return;
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    } catch (err) {
      specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) {
      nextAt = now + interval;
      return;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(img, 0, 0);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);
}

void main();
