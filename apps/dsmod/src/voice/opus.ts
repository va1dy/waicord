/**
 * Opus-кодек на opusscript (libopus, WASM) — единственный нативный
 * кодек проекта: PCM (s16le 48 кГц стерео) ↔ Opus.
 *
 * Статический импорт (не createRequire) — чтобы модуль попадал в
 * standalone-сборку `bun build --compile`.
 */
import OpusEncoder from "opusscript";

/** 48 кГц — частота, которую требует Discord для голоса. */
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
/** Один фрейм Opus = 20 мс = 960 сэмплов на канал. */
export const FRAME_SAMPLES = 960;
/** PCM-байт в одном фрейме: 960 × 2 канала × 2 байта (s16le). */
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
/** Пакет «тишины»: Discord ждёт его до первого аудио, DAVE его пропускает. */
export const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

/** Кодек: по кадрам в обе стороны. Один экземпляр = один голосовой поток. */
export class OpusCodec {
  // 2048 = OPUS_APPLICATION_VOIP
  private readonly encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS, 2048);

  /** Ровно FRAME_BYTES PCM → opus-пакет. */
  encodeFrame(pcm: Buffer): Buffer {
    return this.encoder.encode(pcm, FRAME_SAMPLES);
  }

  /** opus-пакет → PCM (s16le 48 кГц стерео). */
  decode(opus: Buffer): Buffer {
    return this.encoder.decode(opus);
  }
}
