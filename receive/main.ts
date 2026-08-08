// Receiver: camera → WASM QR decode in workers → chunked fountain decoder → file.

import { LTDecoder } from "../shared/fountain";
import { decompressPayload, fnv1a, parseFrame } from "../shared/protocol";

const OVERHEAD_EST = 1.18; // expected frames ≈ K × this (robust-soliton ε)
const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const result = document.getElementById("result")!;
const settings = document.getElementById("settings") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics")!;
const metric = (id: string) => document.getElementById(id)!;

let stream: MediaStream | null = null;
let chunkDecoders: (LTDecoder | null)[] = [];
let totalChunksCount = 0;
let sessionId = -1;
let isCompressed = false;
let startTs = 0;
let captureGen = 0;
let done = false;
let completedChunksCount = 0;

const workers: Worker[] = [];
const busy: boolean[] = [];
const workerStartTime: number[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    stats.textContent =
      "✗ kamera membutuhkan konteks aman (HTTPS) — halaman ini harus dijalankan dengan HTTPS " +
      "untuk mengakses kamera dari perangkat lain (npm run dev).";
    return;
  }
  const cfgW = document.getElementById("cfg-width") as HTMLSelectElement | null;
  const cfgC = document.getElementById("cfg-capfps") as HTMLSelectElement | null;
  const cfgK = document.getElementById("cfg-workers") as HTMLSelectElement | null;
  const captureWidth = cfgW ? Number(cfgW.value) : 1280;
  const captureFps = cfgC ? Number(cfgC.value) : 60;
  const workerCount = cfgK ? Number(cfgK.value) : 4;
  if (settings) settings.style.display = "none";
  startBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };

  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { ideal: captureFps } },
        });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: "environment" },
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true,
          });
        }
      }
    }
  } catch (err) {
    stats.textContent = `✗ gagal membuka kamera: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const track = stream.getVideoTracks()[0];
  const settingsObj = track?.getSettings();
  stats.textContent = `kamera ${settingsObj?.width ?? "?"}×${settingsObj?.height ?? "?"}@${settingsObj?.frameRate ?? "?"} — mencari stream QR… (pastikan pengirim sudah memilih file)`;

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e: MessageEvent) => {
      const { id, bytes } = e.data as { id: number; bytes: Uint8Array | null };
      if (id === -1) {
        // Warm-up signal from worker, do not alter busy state
        return;
      }
      busy[slot] = false;
      if (bytes) void onDecoded(bytes);
    };
    w.onerror = (err) => {
      console.error(`Worker dekode ${slot} error:`, err);
      busy[slot] = false;
    };
    workers.push(w);
    busy.push(false);
    workerStartTime.push(0);
  }

  captureGen++;
  scheduleFrame(captureGen);
  setInterval(updateStats, 500);
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine */
  }
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const now = performance.now();

  // Recovery check: reset any worker that has been stuck in busy state > 1500ms
  for (let i = 0; i < busy.length; i++) {
    if (busy[i] && now - (workerStartTime[i] ?? 0) > 1500) {
      busy[i] = false;
    }
  }

  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop the frame

  // Optimize QR decoding speed: downscale canvas to max 720px width/height.
  // This reduces memory copy from 8.3MB (1080p) down to 1.1MB, making ZXing WASM 7x faster!
  const MAX_DIM = 640;
  let dw = vw;
  let dh = vh;
  if (dw > MAX_DIM || dh > MAX_DIM) {
    if (dw > dh) {
      dh = Math.round((vh * MAX_DIM) / vw);
      dw = MAX_DIM;
    } else {
      dw = Math.round((vw * MAX_DIM) / vh);
      dh = MAX_DIM;
    }
  }

  if (grab.width !== dw || grab.height !== dh) {
    grab.width = dw;
    grab.height = dh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, dw, dh);
  const img = ctx.getImageData(0, 0, dw, dh);
  busy[slot] = true;
  workerStartTime[slot] = now;
  workers[slot]!.postMessage({ id: frameId++, buf: img.data.buffer, w: dw, h: dh }, [
    img.data.buffer,
  ]);
}

async function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;

  if (sessionId !== header.sessionId || totalChunksCount !== header.totalChunks) {
    sessionId = header.sessionId;
    totalChunksCount = header.totalChunks;
    isCompressed = header.compressed ?? false;
    chunkDecoders = new Array(header.totalChunks).fill(null);
    completedChunksCount = 0;
    startTs = performance.now();
    progressEl.style.display = "block";
  }

  const cIdx = header.chunkIdx;
  if (cIdx < 0 || cIdx >= totalChunksCount) return;

  if (!chunkDecoders[cIdx]) {
    const chunkSessionId = (header.sessionId + cIdx * 997) & 0xffff;
    const isLastChunk = cIdx === totalChunksCount - 1;
    const thisChunkTotalLen = isLastChunk
      ? header.totalLen - (totalChunksCount - 1) * CHUNK_SIZE
      : CHUNK_SIZE;
    chunkDecoders[cIdx] = new LTDecoder(
      header.k,
      header.blockLen,
      chunkSessionId,
      thisChunkTotalLen
    );
  }

  const dec = chunkDecoders[cIdx]!;
  if (!dec.isComplete) {
    dec.addFrame(header.seq, block);
    if (dec.isComplete) {
      completedChunksCount++;
    }
  }

  // Calculate overall progress across all chunks
  let totalProgress = 0;
  for (let i = 0; i < totalChunksCount; i++) {
    const d = chunkDecoders[i];
    if (d) {
      if (d.isComplete) {
        totalProgress += 1;
      } else {
        totalProgress += Math.min(0.99, d.solvedCount / d.k);
      }
    }
  }

  const overallFraction = totalProgress / totalChunksCount;
  bar.style.width = `${(overallFraction * 100).toFixed(1)}%`;

  if (completedChunksCount >= totalChunksCount) {
    // All chunks resolved! Reassemble full payload
    const assembledPayload = new Uint8Array(header.totalLen);
    let offset = 0;
    for (let i = 0; i < totalChunksCount; i++) {
      const chunkBytes = chunkDecoders[i]!.assemble()!;
      assembledPayload.set(chunkBytes, offset);
      offset += chunkBytes.length;
    }
    const finalPayload = await decompressPayload(assembledPayload, isCompressed);
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(finalPayload) === header.payloadFnv;
    finish(finalPayload, ok, seconds, header.totalLen);
  }
}

function detectFileType(payload: Uint8Array): { ext: string; mime: string } {
  if (
    payload.length >= 8 &&
    payload[0] === 0x89 &&
    payload[1] === 0x50 &&
    payload[2] === 0x4e &&
    payload[3] === 0x47
  ) {
    return { ext: "png", mime: "image/png" };
  }
  if (
    payload.length >= 3 &&
    payload[0] === 0xff &&
    payload[1] === 0xd8 &&
    payload[2] === 0xff
  ) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    payload.length >= 4 &&
    payload[0] === 0x47 &&
    payload[1] === 0x49 &&
    payload[2] === 0x46 &&
    payload[3] === 0x38
  ) {
    return { ext: "gif", mime: "image/gif" };
  }
  if (
    payload.length >= 12 &&
    payload[0] === 0x52 &&
    payload[1] === 0x49 &&
    payload[2] === 0x46 &&
    payload[3] === 0x46 &&
    payload[8] === 0x57 &&
    payload[9] === 0x45 &&
    payload[10] === 0x42 &&
    payload[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  if (
    payload.length >= 4 &&
    payload[0] === 0x25 &&
    payload[1] === 0x50 &&
    payload[2] === 0x44 &&
    payload[3] === 0x46
  ) {
    return { ext: "pdf", mime: "application/pdf" };
  }
  if (
    payload.length >= 4 &&
    payload[0] === 0x50 &&
    payload[1] === 0x4b &&
    payload[2] === 0x03 &&
    payload[3] === 0x04
  ) {
    return { ext: "zip", mime: "application/zip" };
  }
  if (
    payload.length >= 7 &&
    payload[0] === 0x37 &&
    payload[1] === 0x7a &&
    payload[2] === 0xbc &&
    payload[3] === 0xaf
  ) {
    return { ext: "7z", mime: "application/x-7z-compressed" };
  }
  if (
    payload.length >= 7 &&
    payload[0] === 0x52 &&
    payload[1] === 0x61 &&
    payload[2] === 0x72 &&
    payload[3] === 0x21
  ) {
    return { ext: "rar", mime: "application/vnd.rar" };
  }
  if (
    payload.length >= 8 &&
    payload[4] === 0x66 &&
    payload[5] === 0x74 &&
    payload[6] === 0x79 &&
    payload[7] === 0x70
  ) {
    return { ext: "mp4", mime: "video/mp4" };
  }
  if (
    payload.length >= 3 &&
    payload[0] === 0x49 &&
    payload[1] === 0x44 &&
    payload[2] === 0x33
  ) {
    return { ext: "mp3", mime: "audio/mpeg" };
  }

  // Check if plain text
  let isText = true;
  for (let i = 0; i < Math.min(payload.length, 512); i++) {
    const b = payload[i]!;
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) {
      isText = false;
      break;
    }
  }
  if (isText) return { ext: "txt", mime: "text/plain" };

  return { ext: "bin", mime: "application/octet-stream" };
}

function finish(payload: Uint8Array, hashOk: boolean, seconds: number, totalLen: number) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  preview.style.display = "none";
  bar.style.width = "100%";
  const kb = Math.round(totalLen / 1024);
  const rate = (totalLen / 1024 / seconds).toFixed(1);
  stats.textContent = `${kb} KB dalam ${seconds.toFixed(1)} d · ${rate} KB/s · hash ${hashOk ? "terverifikasi ✓" : "TIDAK COCOK ✗"}`;

  const { ext, mime } = detectFileType(payload);

  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Selesai!";

  const blobUrl = URL.createObjectURL(new Blob([payload as BlobPart], { type: mime }));

  const defaultFileName = `received_file.${ext}`;

  const nameBox = document.createElement("div");
  nameBox.style.margin = "10px 0 5px 0";
  nameBox.style.fontSize = "13px";
  nameBox.style.color = "#9a8f76";
  nameBox.innerHTML = `Nama File & Ekstensi: <input id="fileNameInput" type="text" value="${defaultFileName}" style="font: inherit; background: #121009; color: #ede5d4; border: 1px solid #2e2718; border-radius: 6px; padding: 4px 8px; margin-left: 6px; width: 200px;" />`;

  const downloadBtn = document.createElement("a");
  downloadBtn.href = blobUrl;
  downloadBtn.download = defaultFileName;
  downloadBtn.textContent = "💾 Unduh File";
  downloadBtn.style.display = "inline-block";
  downloadBtn.style.margin = "10px 0";
  downloadBtn.style.padding = "10px 24px";
  downloadBtn.style.background = "#ffb257";
  downloadBtn.style.color = "#121009";
  downloadBtn.style.borderRadius = "8px";
  downloadBtn.style.fontWeight = "700";
  downloadBtn.style.textDecoration = "none";

  const img = document.createElement("img");
  img.className = "received";
  img.src = blobUrl;
  img.onerror = () => {
    img.style.display = "none";
  };

  result.append(heading, nameBox, downloadBtn, document.createElement("br"), img);

  const inputEl = nameBox.querySelector("#fileNameInput") as HTMLInputElement;
  if (inputEl) {
    inputEl.addEventListener("input", () => {
      downloadBtn.download = inputEl.value || defaultFileName;
    });
  }
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - 2000) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  metric("m-cap").textContent = (captureTimes.length / 2).toFixed(0);
  metric("m-dec").textContent = (decodeTimes.length / 2).toFixed(1);

  if (chunkDecoders.length === 0) return;

  let totalFramesNew = 0;
  let totalFramesDup = 0;
  let activeBlockLen = 0;
  let totalFileLen = 0;
  let firstK = 0;

  for (const d of chunkDecoders) {
    if (d) {
      totalFramesNew += d.framesNew;
      totalFramesDup += d.framesDup;
      activeBlockLen = d.blockLen;
      totalFileLen = d.totalLen;
      if (!firstK) firstK = d.k;
    }
  }

  const elapsed = (now - startTs) / 1000;
  const kbs = (totalFramesNew * activeBlockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${totalFramesNew}/${totalFramesDup}`;
  metric("m-k").textContent = `${firstK} (×${totalChunksCount})`;
  metric("m-block").textContent = `${activeBlockLen} B`;
  metric("m-payload").textContent = `${Math.round(totalFileLen / 1024)} KB`;

  stats.textContent = `kamera — Chunk ${completedChunksCount}/${totalChunksCount} Selesai (${completedChunksCount === totalChunksCount ? "100" : Math.floor((completedChunksCount / totalChunksCount) * 100)}%)`;
}
