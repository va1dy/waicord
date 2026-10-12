const CLEAR = 256;
const EOI = 257;

function buildPalette(frames: ImageData[]): Uint32Array {
  const counts = new Map<number, number>();
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 16) {
      const key = ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const palette = new Uint32Array(256);
  const used = entries.slice(0, 256);
  for (let i = 0; i < used.length; i++) {
    const key = used[i]![0];
    const r = ((key >> 10) & 31) << 3;
    const g = ((key >> 5) & 31) << 3;
    const b = (key & 31) << 3;
    palette[i] = (r << 16) | (g << 8) | b;
  }
  for (let i = used.length; i < 256; i++) palette[i] = 0;
  return palette;
}

function quantize(frame: ImageData, palette: Uint32Array, used: number): Uint8Array {
  const map = new Map<number, number>();
  const out = new Uint8Array(frame.width * frame.height);
  const d = frame.data;
  for (let p = 0, i = 0; i < d.length; i += 4, p++) {
    const key = ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
    let idx = map.get(key);
    if (idx === undefined) {
      const r = d[i]!;
      const g = d[i + 1]!;
      const b = d[i + 2]!;
      let best = 0;
      let bestDist = Infinity;
      for (let j = 0; j < used; j++) {
        const c = palette[j]!;
        const dr = r - ((c >> 16) & 255);
        const dg = g - ((c >> 8) & 255);
        const db = b - (c & 255);
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = j;
        }
      }
      idx = best;
      map.set(key, idx);
    }
    out[p] = idx;
  }
  return out;
}

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private nbits = 0;

  write(code: number, size: number) {
    this.cur |= code << this.nbits;
    this.nbits += size;
    while (this.nbits >= 8) {
      this.bytes.push(this.cur & 255);
      this.cur >>= 8;
      this.nbits -= 8;
    }
  }

  finish(): number[] {
    if (this.nbits > 0) this.bytes.push(this.cur & 255);
    const out = this.bytes;
    this.bytes = [];
    this.cur = 0;
    this.nbits = 0;
    return out;
  }
}

function lzw(indices: Uint8Array): number[] {
  const writer = new BitWriter();
  let codeSize = 9;
  let dict = new Map<number, number>();
  let next = EOI + 1;
  writer.write(CLEAR, codeSize);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i]!;
    const key = (prefix << 8) | c;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    writer.write(prefix, codeSize);
    if (next < 4096) {
      dict.set(key, next);
      next++;
      if (next === 4096) {
        writer.write(CLEAR, codeSize);
        dict = new Map();
        next = EOI + 1;
        codeSize = 9;
      } else if (next === 1 << codeSize && codeSize < 12) {
        codeSize++;
      }
    } else {
      writer.write(CLEAR, codeSize);
      dict = new Map();
      next = EOI + 1;
      codeSize = 9;
    }
    prefix = c;
  }
  writer.write(prefix, codeSize);
  writer.write(EOI, codeSize);
  return writer.finish();
}

function blocks(data: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

export function encodeGif(frames: ImageData[], delayCs: number): Uint8Array {
  const w = frames[0]!.width;
  const h = frames[0]!.height;
  const palette = buildPalette(frames);
  let used = 0;
  for (let i = 0; i < 256; i++) {
    if (palette[i] !== 0 || i === 0) used = i + 1;
  }
  used = Math.max(used, 2);

  const out: number[] = [];
  out.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  out.push(w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255);
  out.push(0xf7, 0, 0);
  for (let i = 0; i < 256; i++) {
    const c = palette[i]!;
    out.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
  }
  out.push(0x21, 0xff, 0x0b);
  out.push(...[0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]);
  out.push(3, 1, 0, 0, 0);

  for (const frame of frames) {
    const indices = quantize(frame, palette, used);
    out.push(0x21, 0xf9, 4, 0x04, delayCs & 255, (delayCs >> 8) & 255, 0, 0);
    out.push(0x2c, 0, 0, 0, 0, w & 255, (w >> 8) & 255, h & 255, (h >> 8) & 255, 0);
    out.push(8);
    out.push(...blocks(lzw(indices)));
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

export async function videoToGif(file: File, maxWidth = 160, fps = 10, maxSec = 3): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Не удалось прочитать видео"));
    });
    const duration = Math.min(video.duration || maxSec, maxSec);
    const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
    const w = Math.max(8, Math.round((video.videoWidth || maxWidth) * scale));
    const h = Math.max(8, Math.round((video.videoHeight || maxWidth) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const frames: ImageData[] = [];
    const step = 1 / fps;
    for (let t = 0; t < duration && frames.length < Math.ceil(maxSec * fps); t += step) {
      await seek(video, Math.min(t, Math.max(0, duration - 0.01)));
      ctx.drawImage(video, 0, 0, w, h);
      frames.push(ctx.getImageData(0, 0, w, h));
    }
    if (frames.length === 0) throw new Error("Видео пустое");
    const gif = encodeGif(frames, Math.max(2, Math.round(100 / fps)));
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < gif.length; i += chunk) {
      bin += String.fromCharCode(...gif.subarray(i, i + chunk));
    }
    return `data:image/gif;base64,${btoa(bin)}`;
  } finally {
    URL.revokeObjectURL(url);
  }
}
