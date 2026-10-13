/**
 * Голосовое соединение: один voice-gateway (WS v8) + один UDP-поток.
 *
 * Жизненный цикл: identify → ready (ssrc/адрес) → IP-discovery →
 * select protocol → session description (ключ, режим, DAVE) → ready.
 * Аудио уходит RTP-пакетами (Opus + транспортный AEAD + DAVE),
 * входящие расшифровываются и декодируются в PCM.
 *
 * Менеджер (VoiceManager) держит не больше одной такой сессии.
 */
import { EventEmitter } from "node:events";
import dgram, { type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { DaveHandler, DAVE_PROTOCOL_VERSION } from "./dave";
import { FRAME_BYTES, FRAME_SAMPLES, OpusCodec } from "./opus";
import {
  SUPPORTED_MODES,
  buildRtpHeader,
  chooseMode,
  decryptRtpPayload,
  encryptRtpPacket,
  readSsrc,
  type EncryptionMode,
} from "./rtp";

/** Версия voice gateway: v8 поддерживает DAVE (E2EE). */
const VOICE_GATEWAY_VERSION = 8;
const DISCOVERY_TIMEOUT_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 5000;
const MAX_MISSED_HEARTBEATS = 3;
const MAX_RESUME_ATTEMPTS = 3;
/** Через сколько молчания снимаем флаг speaking. */
const SPEAKING_IDLE_MS = 4000;

export interface VoiceConnectionOptions {
  /** guild_id, а для звонка в ЛС — id канала (таков протокол identify). */
  serverId: string;
  channelId: string;
  guildId: string | null;
  token: string;
  /** host[:port] из VOICE_SERVER_UPDATE. */
  endpoint: string;
  /** session_id из VOICE_STATE_UPDATE. */
  sessionId: string;
  userId: string;
}

/** Фазы одной голосовой сессии (попадают в DTO и логи). */
export type VoiceLinkPhase = "connecting" | "selecting" | "ready" | "resuming" | "closed";

export interface VoiceLinkStatus {
  phase: VoiceLinkPhase;
  ssrc: number | null;
  mode: string | null;
  speaking: number;
}

interface Remote {
  ip: string;
  port: number;
}

export class VoiceConnection extends EventEmitter {
  phase: VoiceLinkPhase = "connecting";
  ssrc = 0;
  mode: EncryptionMode | null = null;
  speaking = 0;
  readonly channelId: string;

  private ws: WebSocket | null = null;
  private udp: Socket | null = null;
  private remote: Remote | null = null;
  private key: Uint8Array | null = null;

  /** Последний полученный seq voice-gateway (-1 — ещё не было пакетов). */
  private seq = -1;
  private missed = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDiscovery: ((msg: Buffer) => boolean) | null = null;

  private rtpSeq = 0;
  private rtpTs = 0;
  private nonce = 0;
  private resumeAttempts = 0;
  private stopped = false;

  private readonly codec = new OpusCodec();
  private readonly dave: DaveHandler;
  private readonly ssrcToUser = new Map<number, string>();

  constructor(private readonly opts: VoiceConnectionOptions) {
    super();
    this.channelId = opts.channelId;
    this.dave = new DaveHandler(opts.userId, opts.channelId, {
      sendJson: (op, d) => this.sendJson(op, d),
      sendBinary: (op, payload) => this.sendBinary(op, payload),
      onState: (state) => this.emit("dave", state),
      onDebug: (message) => this.emit("debug", message),
    });
  }

  /** Открывает voice-gateway и запускает ручку. */
  start(): void {
    this.openWs(false);
  }

  /** Останавливает соединение без права на реконнект. */
  destroy(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.stopKeepalive();
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.pendingDiscovery = null;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendJson(5, { speaking: 0, delay: 0, ssrc: this.ssrc });
        this.ws.close(1000);
      }
    } catch {
      // сокет уже мог закрыться
    }
    this.ws = null;
    this.closeUdp();
    this.phase = "closed";
  }

  /** Флаги speaking (битовая маска: 1 — голос); шлётся до аудио-пакетов. */
  setSpeaking(flags: number | boolean): void {
    const value = typeof flags === "boolean" ? (flags ? 1 : 0) : flags & 0xff;
    if (this.speaking === value) return;
    this.speaking = value;
    this.sendJson(5, { speaking: value, delay: 0, ssrc: this.ssrc });
    this.emitStatus();
  }

  /** opus-пакет → голосовой канал. false — соединение не готово. */
  sendAudio(opus: Buffer): boolean {
    if (this.phase !== "ready" || !this.udp || !this.remote || !this.mode || !this.key) return false;
    if (this.speaking === 0) this.setSpeaking(1);
    const payload = this.dave.enabled ? this.dave.encrypt(opus) : opus;
    const header = buildRtpHeader(this.rtpSeq, this.rtpTs, this.ssrc);
    this.nonce = (this.nonce + 1) >>> 0;
    const packet = encryptRtpPacket(this.mode, this.key, header, payload, this.nonce);
    this.udp.send(packet, this.remote.port, this.remote.ip);
    this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
    this.rtpTs = (this.rtpTs + FRAME_SAMPLES) >>> 0;
    return true;
  }

  /**
   * PCM (s16le 48 кГц стерео, кратно 20 мс) → канал.
   * Возвращает число отправленных фреймов; speaking снимается через 4 с покоя.
   */
  sendPcm(pcm: Buffer): number {
    const frames = Math.floor(pcm.length / FRAME_BYTES);
    let sent = 0;
    for (let i = 0; i < frames; i++) {
      const frame = pcm.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
      if (this.sendAudio(this.codec.encodeFrame(frame))) sent += 1;
    }
    if (sent > 0) {
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this.setSpeaking(0), SPEAKING_IDLE_MS);
    }
    return sent;
  }

  // ---- voice-gateway ---------------------------------------------------

  private openWs(resume: boolean): void {
    const host = this.opts.endpoint.replace(/^wss?:\/\//, "");
    const url = `wss://${host}?v=${VOICE_GATEWAY_VERSION}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    if (!resume) {
      this.speaking = 0;
      this.seq = -1;
    }

    ws.onopen = () => {
      if (resume) {
        this.sendJson(7, {
          server_id: this.opts.serverId,
          session_id: this.opts.sessionId,
          token: this.opts.token,
          seq_ack: this.seq,
        });
      } else {
        this.sendJson(0, {
          server_id: this.opts.serverId,
          user_id: this.opts.userId,
          session_id: this.opts.sessionId,
          token: this.opts.token,
          max_dave_protocol_version: DAVE_PROTOCOL_VERSION,
        });
      }
    };
    ws.onmessage = (event) => this.onMessage(event.data);
    ws.onerror = () => this.emit("debug", "voice ws: ошибка сокета");
    ws.onclose = (event) => this.onClose(event.code);
  }

  private onMessage(data: unknown): void {
    if (typeof data === "string") {
      let packet: { op?: number; d?: Record<string, any>; s?: number } | null = null;
      try {
        packet = JSON.parse(data);
      } catch {
        return;
      }
      if (packet) this.onJson(packet);
      return;
    }
    const buf =
      data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data instanceof Uint8Array
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : null;
    if (buf) this.onBinary(buf);
  }

  private onJson(packet: { op?: number; d?: Record<string, any>; s?: number }): void {
    if (typeof packet.s === "number") this.seq = packet.s;
    const d = packet.d ?? {};
    switch (packet.op) {
      case 2: {
        // Ready: наш ssrc и адрес голосового сервера → UDP-хендшейк
        if (this.udp || this.stopped) break;
        this.ssrc = Number(d.ssrc ?? 0);
        this.remote = { ip: String(d.ip ?? ""), port: Number(d.port ?? 0) };
        this.createUdp();
        this.startKeepalive();
        void this.selectProtocol(Array.isArray(d.modes) ? d.modes.map(String) : []).catch((err: unknown) => {
          this.emit("debug", `voice udp handshake: ${String(err)}`);
          try {
            this.ws?.close();
          } catch {
            // ignore
          }
        });
        break;
      }
      case 4: {
        // Session Description: ключи, режим, версия DAVE → соединение готово
        if (this.stopped || this.phase === "closed") break;
        const mode = String(d.mode ?? "") as EncryptionMode;
        const secretKey = d.secret_key;
        if (!SUPPORTED_MODES.includes(mode) || !Array.isArray(secretKey) || secretKey.length !== 32) {
          this.emit("debug", `voice: некорректный session description (mode=${mode})`);
          break;
        }
        this.mode = mode;
        this.key = Uint8Array.from(secretKey);
        this.rtpSeq = Math.floor(Math.random() * 0x10000);
        this.rtpTs = Math.floor(Math.random() * 0x1_0000_0000);
        this.nonce = 0;
        this.resumeAttempts = 0;
        this.dave.init(Number(d.dave_protocol_version ?? 0));
        this.phase = "ready";
        this.emitStatus();
        break;
      }
      case 5: {
        // Speaking (сервер → клиент): связка ssrc ↔ user_id + флаги
        const userId = d.user_id ? String(d.user_id) : null;
        const ssrc = Number(d.ssrc ?? 0);
        if (!userId || !ssrc) break;
        this.ssrcToUser.set(ssrc, userId);
        this.emit("speaking", { userId, ssrc, speaking: Number(d.speaking ?? 0) });
        break;
      }
      case 6:
        this.missed = 0;
        break;
      case 8:
        this.startHeartbeat(Number(d.heartbeat_interval ?? 41250));
        break;
      case 9: // Resumed
        this.phase = "ready";
        this.resumeAttempts = 0;
        this.emitStatus();
        break;
      case 11:
        for (const id of Array.isArray(d.user_ids) ? d.user_ids : []) this.dave.addRecognized(String(id));
        break;
      case 13:
        this.removeUser(String(d.user_id ?? ""));
        break;
      case 21: {
        if (this.phase !== "ready" && this.phase !== "resuming") break;
        const transitionId = Number(d.transition_id ?? 0);
        const needsAck = this.dave.prepareTransition(d);
        if (needsAck) this.sendJson(23, { transition_id: transitionId });
        break;
      }
      case 22:
        if (!this.dave.executeTransition(Number(d.transition_id ?? 0))) {
          this.emit("debug", `voice: неизвестный transition ${String(d.transition_id)}`);
        }
        break;
      case 24:
        this.dave.prepareEpoch(d);
        break;
      default:
        break;
    }
  }

  private onBinary(buf: Buffer): void {
    if (buf.length < 3 || this.stopped) return;
    this.seq = buf.readUInt16BE(0);
    const op = buf.readUInt8(2);
    if (this.phase !== "ready" && this.phase !== "resuming") return;
    const payload = buf.subarray(3);
    switch (op) {
      case 25:
        this.dave.setExternalSender(payload);
        break;
      case 27:
        this.dave.processProposals(payload);
        break;
      case 29:
        this.dave.processCommit(payload);
        break;
      case 30:
        this.dave.processWelcome(payload);
        break;
      default:
        break;
    }
  }

  private onClose(code: number): void {
    this.stopHeartbeat();
    if (this.stopped) return;

    const terminal = code === 4014 || code === 4021 || code === 4022;
    const canResume =
      !terminal &&
      code < 4000 &&
      (this.phase === "ready" || this.phase === "resuming") &&
      this.resumeAttempts < MAX_RESUME_ATTEMPTS;

    if (canResume) {
      // Сбой на стороне сети/сервера — пробуем resume на том же сервере
      this.resumeAttempts += 1;
      this.phase = "resuming";
      this.emitStatus();
      this.openWs(true);
      return;
    }

    this.phase = "closed";
    this.stopKeepalive();
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.pendingDiscovery = null;
    this.closeUdp();
    this.emit("close", { code, terminal });
  }

  private sendJson(op: number, d: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ op, d }));
    } catch (err) {
      this.emit("debug", `voice send(${op}): ${String(err)}`);
    }
  }

  private sendBinary(op: number, payload: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(Buffer.concat([Buffer.from([op]), payload]));
    } catch (err) {
      this.emit("debug", `voice sendBinary(${op}): ${String(err)}`);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.missed = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.missed >= MAX_MISSED_HEARTBEATS) {
        // ACK не пришёл — закрываем сокет (код <4000 → resume-путь)
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
        return;
      }
      this.missed += 1;
      this.sendJson(3, { t: Date.now(), seq_ack: this.seq });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ---- UDP -------------------------------------------------------------

  private createUdp(): void {
    const udp = dgram.createSocket("udp4");
    udp.on("message", (msg) => this.onUdp(msg));
    udp.on("error", (err) => this.emit("debug", `voice udp: ${err.message}`));
    udp.bind(0);
    this.udp = udp;
  }

  private closeUdp(): void {
    if (!this.udp) return;
    try {
      this.udp.close();
    } catch {
      // уже закрыт
    }
    this.udp = null;
  }

  /** IP-discovery → select protocol (режим шифрования). */
  private async selectProtocol(serverModes: string[]): Promise<void> {
    const mode = chooseMode(serverModes);
    const local = await this.discoverIp();
    if (this.stopped) return;
    this.phase = "selecting";
    this.sendJson(1, { protocol: "udp", data: { address: local.ip, port: local.port, mode } });
  }

  private discoverIp(): Promise<Remote> {
    const udp = this.udp;
    const remote = this.remote;
    if (!udp || !remote) return Promise.reject(new Error("UDP ещё не создан"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDiscovery = null;
        reject(new Error("IP discovery: таймаут"));
      }, DISCOVERY_TIMEOUT_MS);
      this.pendingDiscovery = (msg: Buffer) => {
        if (msg.length < 10 || msg.readUInt16BE(0) !== 2) return false;
        clearTimeout(timer);
        this.pendingDiscovery = null;
        const ip = msg.subarray(8, msg.indexOf(0, 8)).toString("utf8");
        const port = msg.readUInt16BE(msg.length - 2);
        if (!isIPv4(ip)) {
          reject(new Error("IP discovery: невалидный адрес"));
          return true;
        }
        resolve({ ip, port });
        return true;
      };
      const request = Buffer.alloc(74); // ровно как у эталона: 74 байта, length=70
      request.writeUInt16BE(1, 0); // тип: request
      request.writeUInt16BE(70, 2);
      request.writeUInt32BE(this.ssrc, 4);
      udp.send(request, remote.port, remote.ip);
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    let counter = 0;
    const tick = () => {
      if (!this.udp || !this.remote) return;
      const packet = Buffer.allocUnsafe(8);
      packet.writeUInt32LE(counter >>> 0, 0);
      counter = (counter + 1) >>> 0;
      this.udp.send(packet, this.remote.port, this.remote.ip);
    };
    tick();
    this.keepaliveTimer = setInterval(tick, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private onUdp(msg: Buffer): void {
    if (this.pendingDiscovery?.(msg)) return;
    if (msg.length < 12 || (msg[1] & 0x7f) !== 0x78 || (msg[0] >> 6) !== 2) return;

    const ssrc = readSsrc(msg);
    const userId = this.ssrcToUser.get(ssrc);
    if (!userId || !this.mode || !this.key) return;

    const payload = decryptRtpPayload(this.mode, this.key, msg);
    if (!payload) return;

    const opus = this.dave.enabled ? this.dave.decrypt(userId, payload) : payload;
    if (!opus) return;

    let pcm: Buffer;
    try {
      pcm = this.codec.decode(opus);
    } catch {
      return;
    }
    this.emit("audio", { userId, pcm });
  }

  private removeUser(userId: string): void {
    let ssrc = 0;
    for (const [candidate, id] of this.ssrcToUser) {
      if (id === userId) {
        ssrc = candidate;
        this.ssrcToUser.delete(candidate);
      }
    }
    this.dave.removeRecognized(userId);
    if (ssrc) this.emit("speaking", { userId, ssrc, speaking: 0 });
  }

  private emitStatus(): void {
    this.emit("status", this.status());
  }

  status(): VoiceLinkStatus {
    return { phase: this.phase, ssrc: this.ssrc || null, mode: this.mode, speaking: this.speaking };
  }
}
