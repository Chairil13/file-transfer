// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.

import { LTDecoder } from "../shared/fountain";
import { fnv1a, parseFrame } from "../shared/protocol";

const OVERHEAD_EST = 1.18; // expected frames ≈ K × this (robust-soliton ε)

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
let decoder: LTDecoder | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;

const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL — this is the plain-
    // http-over-LAN case. localhost is exempt; other hosts need https.
    stats.textContent =
      "✗ camera needs a secure context — this page must be served over " +
      "https to use the camera from another device (npm run dev:https).";
    return;
  }
  const captureWidth = Number((document.getElementById("cfg-width") as HTMLSelectElement).value);
  const captureFps = Number((document.getElementById("cfg-capfps") as HTMLSelectElement).value);
  const workerCount = Number((document.getElementById("cfg-workers") as HTMLSelectElement).value);
  settings.style.display = "none";
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    stats.textContent = `✗ camera: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  stats.textContent = `camera ${stream.getVideoTracks()[0]?.getSettings().width}×${stream.getVideoTracks()[0]?.getSettings().height}@${stream.getVideoTracks()[0]?.getSettings().frameRate} — searching for a stream…`;

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e: MessageEvent) => {
      const { id, bytes } = e.data as { id: number; bytes: Uint8Array | null };
      if (id === -1) return; // warm-up
      busy[slot] = false;
      if (bytes) onDecoded(bytes);
    };
    workers.push(w);
    busy.push(false);
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
  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop the frame, no harm done
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  busy[slot] = true;
  workers[slot]!.postMessage({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [
    img.data.buffer,
  ]);
}

function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
  }
  decoder.addFrame(header.seq, block);
  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  bar.style.width = `${(progress * 100).toFixed(1)}%`;

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    finish(payload, ok, seconds, header.totalLen);
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
  stats.textContent = `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · hash ${hashOk ? "verified ✓" : "MISMATCH ✗"}`;

  const { ext, mime } = detectFileType(payload);

  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Complete!";

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
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
