// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

const fullWasmUrl = new URL(wasmUrl, import.meta.url).href;

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? fullWasmUrl : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h, grayscale } = e.data as {
    id: number;
    buf: ArrayBuffer;
    w: number;
    h: number;
    grayscale?: boolean;
  };
  try {
    let img: ImageData;
    if (grayscale) {
      // Expand grayscale 8-bit → RGBA for ZXing (transfer was 75% smaller)
      const gray = new Uint8Array(buf);
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        const v = gray[i]!;
        rgba[j] = v;
        rgba[j + 1] = v;
        rgba[j + 2] = v;
        rgba[j + 3] = 255;
      }
      img = new ImageData(rgba, w, h);
    } else {
      img = new ImageData(new Uint8ClampedArray(buf), w, h);
    }
    const results = await readBarcodes(img, { formats: ["QRCode"], maxNumberOfSymbols: 1 });
    const r = results.find((x) => x.isValid && x.bytes.length > 0);
    ctx.postMessage({ id, bytes: r ? r.bytes : null });
  } catch {
    ctx.postMessage({ id, bytes: null });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
