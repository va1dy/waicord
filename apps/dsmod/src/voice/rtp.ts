/**
 * RTP-пакеты Discord Voice и транспортное шифрование.
 *
 * Режимы `aead_*_rtpsize`: незашифрованным остаётся только RTP-хедер
 * (он же AAD), nonce = [u32 BE счётчик][нули], тот же счётчик
 * дописывается в хвост пакета. Источник истины — документация Discord
 * (Voice Connections) и эталонная реализация @discordjs/voice.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

export type EncryptionMode = "aead_aes256_gcm_rtpsize" | "aead_xchacha20_poly1305_rtpsize";

/** Payload type, которым Discord кодирует Opus в голосовом UDP. */
export const RTP_PAYLOAD_TYPE = 0x78;

/** Режимы, которые обязан уметь клиент (сервер предлагает хотя бы один). */
export const SUPPORTED_MODES: readonly EncryptionMode[] = [
  "aead_aes256_gcm_rtpsize",
  "aead_xchacha20_poly1305_rtpsize",
];

/** Выбираем режим: AES-GCM если его предложили (аппаратный), иначе XChaCha20. */
export function chooseMode(serverModes: string[]): EncryptionMode {
  for (const mode of SUPPORTED_MODES) {
    if (serverModes.includes(mode)) return mode;
  }
  throw new Error(`Голосовой сервер не поддерживает нужные режимы: ${serverModes.join(", ") || "(нет)"}`);
}

/** Хедер RTP: V=1, CC=0, PT=0x78, seq(16), timestamp(32), ssrc(32). */
export function buildRtpHeader(seq: number, timestamp: number, ssrc: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = RTP_PAYLOAD_TYPE;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return header;
}

/** ssrc из входящего пакета — по нему ищем владельца (user id). */
export function readSsrc(packet: Buffer): number {
  return packet.readUInt32BE(8);
}

function nonceFor(mode: EncryptionMode, counter: number): Buffer {
  const nonce = Buffer.alloc(mode === "aead_aes256_gcm_rtpsize" ? 12 : 24);
  nonce.writeUInt32BE(counter >>> 0, 0);
  return nonce;
}

/** Размер незашифрованной части: фикс. хедер + CSRC + первые 4 байта расширения. */
function headerSizeOf(packet: Buffer): number {
  const cc = packet[0] & 0x0f;
  let size = 12 + 4 * cc;
  if ((packet[0] >> 4) & 1) size += 4;
  return size;
}

/** Шифрует opus-полезную нагрузку → готовый RTP-пакет (header‖cipher‖tag‖nonce). */
export function encryptRtpPacket(
  mode: EncryptionMode,
  key: Uint8Array,
  header: Buffer,
  payload: Buffer,
  counter: number,
): Buffer {
  const nonce = nonceFor(mode, counter);
  let sealed: Buffer;
  if (mode === "aead_aes256_gcm_rtpsize") {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(header);
    sealed = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  } else {
    // noble возвращает ciphertext‖tag одним куском
    sealed = Buffer.from(xchacha20poly1305(key, nonce, header).encrypt(payload));
  }
  const tail = Buffer.allocUnsafe(4);
  tail.writeUInt32BE(counter >>> 0, 0);
  return Buffer.concat([header, sealed, tail]);
}

/** Расшифровывает входящий RTP-пакет → opus-нагрузка (null — если пакет битый). */
export function decryptRtpPayload(mode: EncryptionMode, key: Uint8Array, packet: Buffer): Buffer | null {
  if (packet.length < 32) return null;
  if ((packet[0] >> 6) !== 2 || (packet[1] & 0x7f) !== RTP_PAYLOAD_TYPE) return null;

  const headerSize = headerSizeOf(packet);
  // хвостовой nonce — 4 байта, перед ним auth tag — 16 байт
  if (packet.length < headerSize + 20) return null;

  const header = packet.subarray(0, headerSize);
  const nonce = nonceFor(mode, packet.readUInt32BE(packet.length - 4));
  let payload: Buffer;
  try {
    if (mode === "aead_aes256_gcm_rtpsize") {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(header);
      decipher.setAuthTag(packet.subarray(packet.length - 20, packet.length - 4));
      payload = Buffer.concat([
        decipher.update(packet.subarray(headerSize, packet.length - 20)),
        decipher.final(),
      ]);
    } else {
      payload = Buffer.from(xchacha20poly1305(key, nonce, header).decrypt(packet.subarray(headerSize, packet.length - 4)));
    }
  } catch {
    return null; // подпись не сошлась — мусор или чужой пакет
  }

  // RTP-паддинг (бит P): последний байт нагрузки = его размер
  if (packet[0] & 0x20) {
    const pad = payload[payload.length - 1];
    if (!pad || pad > payload.length) return null;
    payload = payload.subarray(0, payload.length - pad);
  }
  // Расширение RTP: тело (4 × len слов) лежит в начале расшифрованной нагрузки
  if ((packet[0] >> 4) & 1) {
    const extOffset = 12 + 4 * (packet[0] & 0x0f);
    if (extOffset + 4 > packet.length) return null;
    const extBytes = 4 * packet.readUInt16BE(extOffset + 2);
    if (extBytes > payload.length) return null;
    payload = payload.subarray(extBytes);
  }
  return payload;
}
