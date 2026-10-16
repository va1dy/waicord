/**
 * Go Live: видеотрансляция экрана в серверный голосовой канал.
 *
 * Схема (по эталону Discord-video-stream, ISC):
 *   опкод 18 STREAM_CREATE → dispatch STREAM_CREATE (rtc_server_id) и
 *   STREAM_SERVER_UPDATE (endpoint, token) → отдельный voice-gateway с
 *   identify video:true → ready.streams[0] (ssrc/rtx видео) → IP-discovery →
 *   select protocol ("udp", codecs H264…) → session description
 *   (ключ, режим, версия DAVE) → опкод 12 VIDEO (анонс потока) +
 *   speaking=2 → RTP-пакеты H264 (Single NAL / FU-A, MTU 1200).
 *
 * Шифрование: транспортный AEAD из rtp.ts (как у аудио) плюс DAVE —
 * при активной MLS-группе кадр целиком шифруется davey
 * (MediaType.VIDEO, Codec.H264) до нарезки. Канал MLS для стрима —
 * rtc_server_id − 1 (эмпирическое правило эталона).
 */
import { EventEmitter } from "node:events";
import dgram, { type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { wsInit } from "../net";
import { DaveHandler, DAVE_PROTOCOL_VERSION } from "./dave";
import { SUPPORTED_MODES, chooseMode, encryptRtpPacket, type EncryptionMode } from "./rtp";

/** Payload type видео H264 (см. docs/voice.md). */
const VIDEO_PAYLOAD_TYPE = 101;
/** Предел полезной нагрузки одного RTP-пакета (как в эталоне). */
const VIDEO_MTU = 1200;
/** Расширение RFC 5285: профиль 0xBEDE, 1 слово. */
const EXT_HEADER = Buffer.from([0xbe, 0xde, 0x00, 0x01]);
/** Play-out delay (ext 5): min=0, max=0. */
const EXT_PLAYOUT_DELAY = Buffer.from([0x52, 0x00, 0x00, 0x00]);
/** Старт-код Annex-B для нарезки NAL. */
const START_CODE = Buffer.from([0, 0, 1]);

const DISCOVERY_TIMEOUT_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 5000;
const MAX_MISSED_HEARTBEATS = 3;
const MAX_RESUME_ATTEMPTS = 3;
/** Интервал RTCP Sender Report (эталон: раз в секунду). */
const RTCP_SR_INTERVAL_MS = 1000;
/** Начало NTP-эпохи — для поля NTP в отчёте. */
const NTP_EPOCH_MS = new Date("Jan 01 1900 GMT").getTime();
const MAX_UINT32 = 0x1_0000_0000;

/** Симулкаст, который заявляем в identify (эталон: один поток «screen»). */
const STREAM_SIMULCAST = [{ type: "screen", rid: "100", quality: 100 }];

/** Кодеки для select protocol (payload type'ы Discord, как в эталоне). */
const SELECT_PROTOCOL_CODECS = [
  { name: "opus", type: "audio", priority: 1000, payload_type: 120 },
  { name: "H264", type: "video", priority: 1000, payload_type: 101, rtx_payload_type: 102, encode: true, decode: true },
  { name: "H265", type: "video", priority: 1000, payload_type: 103, rtx_payload_type: 104, encode: true, decode: true },
  { name: "VP8", type: "video", priority: 1000, payload_type: 105, rtx_payload_type: 106, encode: true, decode: true },
  { name: "VP9", type: "video", priority: 1000, payload_type: 107, rtx_payload_type: 108, encode: true, decode: true },
  { name: "AV1", type: "video", priority: 1000, payload_type: 109, rtx_payload_type: 110, encode: true, decode: true },
];

export interface StreamConnectionOptions {
  /** rtc_server_id из dispatch STREAM_CREATE — он же server_id в identify. */
  serverId: string;
  guildId: string;
  channelId: string;
  token: string;
  /** host[:port] из STREAM_SERVER_UPDATE. */
  endpoint: string;
  /** session_id из VOICE_STATE_UPDATE (та же сессия, что у голоса). */
  sessionId: string;
  userId: string;
  video: { width: number; height: number; fps: number };
}

export type StreamPhase = "connecting" | "selecting" | "ready" | "resuming" | "closed";

export interface StreamLinkStatus {
  phase: StreamPhase;
  ssrc: number | null;
  mode: string | null;
  frames: number;
  bytes: number;
}

interface Remote {
  ip: string;
  port: number;
}

/** Канал MLS для стрима: rtc_server_id − 1 (правило эталона). */
function daveChannelIdFor(serverId: string): string {
  try {
    const value = BigInt(serverId);
    return value > 0n ? (value - 1n).toString() : serverId;
  } catch {
    return serverId;
  }
}

/** Нарезка Annex-B по старт-кодам (семантика splitNalu из эталона). */
function splitNalu(buf: Buffer): Buffer[] {
  const nalus: Buffer[] = [];
  let temp = buf;
  while (temp.length > 0) {
    let pos = temp.indexOf(START_CODE);
    let length = 3;
    if (pos > 0 && temp[pos - 1] === 0) {
      pos -= 1;
      length = 4;
    }
    if (pos === -1) {
      nalus.push(temp);
      break;
    }
    const nalu = temp.subarray(0, pos);
    if (nalu.length > 0) nalus.push(nalu);
    temp = temp.subarray(pos + length);
  }
  return nalus;
}

export class StreamConnection extends EventEmitter {
  phase: StreamPhase = "connecting";
  mode: EncryptionMode | null = null;
  frames = 0;
  bytes = 0;

  private ws: WebSocket | null = null;
  private udp: Socket | null = null;
  private remote: Remote | null = null;
  private key: Uint8Array | null = null;
  private audioSsrc = 0;
  private videoSsrc = 0;
  private rtxSsrc = 0;

  private seq = -1;
  private missed = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private pendingDiscovery: ((msg: Buffer) => boolean) | null = null;

  private rtpSeq = 0;
  private rtpTs = 0;
  private nonce = 0;
  private resumeAttempts = 0;
  private stopped = false;

  // RTCP sender report (как в эталоне: раз в секунду, иначе стрим-сервер
  // считает медиа-сессию «мёртвой» и завершает трансляцию)
  private rtcpPackets = 0;
  private rtcpOctets = 0;
  private mediaTsMs = 0;
  private lastRtcpMs = 0;
  private lastPacketTime = 0;

  private readonly dave: DaveHandler;

  constructor(private readonly opts: StreamConnectionOptions) {
    super();
    this.dave = new DaveHandler(opts.userId, daveChannelIdFor(opts.serverId), {
      sendJson: (op, d) => this.sendJson(op, d),
      sendBinary: (op, payload) => this.sendBinary(op, payload),
      onState: (state) => this.emit("dave", state),
      onDebug: (message) => this.emit("debug", message),
    });
  }

  /** Открывает голосовой gateway стрима (v8, как у голоса). */
  start(): void {
    this.openWs(false);
  }

  /** Подключение (или переподключение через op7 RESUME после обрыва). */
  private openWs(resume: boolean): void {
    const host = this.opts.endpoint.replace(/^wss?:\/\//, "");
    const ws = new WebSocket(`wss://${host}?v=8`, wsInit() as any);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (resume) {
        this.sendJson(7, {
          server_id: this.opts.serverId,
          session_id: this.opts.sessionId,
          token: this.opts.token,
          seq_ack: this.seq,
        });
        return;
      }
      this.sendJson(0, {
        server_id: this.opts.serverId,
        user_id: this.opts.userId,
        session_id: this.opts.sessionId,
        token: this.opts.token,
        video: true,
        streams: STREAM_SIMULCAST,
        max_dave_protocol_version: DAVE_PROTOCOL_VERSION,
      });
    };
    ws.onmessage = (event) => this.onMessage(event.data);
    ws.onerror = () => this.emit("debug", "stream ws: ошибка сокета");
    ws.onclose = (event) => {
      this.emit("debug", `stream ws: закрыт (код ${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      this.onClose(event.code);
    };
  }

  /** Останавливает соединение. */
  destroy(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.stopKeepalive();
    this.pendingDiscovery = null;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendJson(5, { speaking: 0, delay: 0, ssrc: this.audioSsrc });
        this.ws.close(1000);
      }
    } catch {
      // сокет уже мог закрыться
    }
    this.ws = null;
    this.closeUdp();
    this.phase = "closed";
  }

  /**
   * Кадр Annex-B H264 → RTP-пакеты в UDP.
   * frametimeMs — шаг метки времени (90000 × frametimeMs / 1000).
   */
  sendVideoFrame(frame: Buffer, frametimeMs: number): boolean {
    if (this.phase !== "ready" || !this.udp || !this.remote || !this.mode || !this.key) return false;
    const data = this.dave.encryptVideo(frame);
    if (data.length === 0) return false;

    this.lastPacketTime = Date.now();
    let packets = 0;
    let octets = 0;
    const nalus = splitNalu(data);
    for (let index = 0; index < nalus.length; index++) {
      const nalu = nalus[index]!;
      const isLastNal = index === nalus.length - 1;
      if (nalu.length <= VIDEO_MTU) {
        octets += this.sendPacket(Buffer.concat([EXT_PLAYOUT_DELAY, nalu]), isLastNal);
        packets += 1;
        continue;
      }
      // FU-A: заголовок NAL несём в FU-индикаторе/заголовке
      const nalHeader = nalu[0]!;
      const fnri = nalHeader & 0xe0;
      const nalType = nalHeader & 0x1f;
      const body = nalu.subarray(1);
      let offset = 0;
      while (offset < body.length) {
        const chunk = body.subarray(offset, offset + VIDEO_MTU);
        offset += chunk.length;
        const isFirst = offset === chunk.length;
        const isFinal = offset >= body.length;
        const fu = Buffer.allocUnsafe(2 + chunk.length);
        fu[0] = 0x1c | fnri;
        fu[1] = (isFirst ? 0x80 : 0) | (isFinal ? 0x40 : 0) | nalType;
        chunk.copy(fu, 2);
        octets += this.sendPacket(Buffer.concat([EXT_PLAYOUT_DELAY, fu]), isLastNal && isFinal);
        packets += 1;
      }
    }

    // Счётчики и RTCP Sender Report раз в секунду — без него стрим-сервер
    // считает медиа-сессию мёртвой и завершает трансляцию (как в эталоне).
    this.rtcpPackets = (this.rtcpPackets + packets) % MAX_UINT32;
    this.rtcpOctets = (this.rtcpOctets + octets) % MAX_UINT32;
    if (
      Math.floor(this.mediaTsMs / RTCP_SR_INTERVAL_MS) >
      Math.floor(this.lastRtcpMs / RTCP_SR_INTERVAL_MS)
    ) {
      this.sendSenderReport();
      this.lastRtcpMs = this.mediaTsMs;
    }
    this.mediaTsMs += Math.max(1, Math.round(frametimeMs));

    this.rtpTs = (this.rtpTs + Math.max(1, Math.round((90000 * frametimeMs) / 1000))) >>> 0;
    this.frames += 1;
    this.bytes += frame.length;
    return true;
  }

  status(): StreamLinkStatus {
    return {
      phase: this.phase,
      ssrc: this.videoSsrc || null,
      mode: this.mode,
      frames: this.frames,
      bytes: this.bytes,
    };
  }

  // ---- RTP -------------------------------------------------------------

  /** Один RTP-пакет: хедер (AAD) + расширение + нагрузка + AEAD-хвост. */
  private sendPacket(payload: Buffer, marker: boolean): number {
    const header = Buffer.allocUnsafe(16);
    header[0] = 0x90; // V=2, X=1
    header[1] = VIDEO_PAYLOAD_TYPE | (marker ? 0x80 : 0);
    header.writeUInt16BE(this.rtpSeq, 2);
    header.writeUInt32BE(this.rtpTs >>> 0, 4);
    header.writeUInt32BE(this.videoSsrc >>> 0, 8);
    EXT_HEADER.copy(header, 12);

    this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
    this.nonce = (this.nonce + 1) >>> 0;
    const packet = encryptRtpPacket(this.mode!, this.key!, header, payload, this.nonce);
    this.udp!.send(packet, this.remote!.port, this.remote!.ip);
    return packet.length;
  }

  /**
   * RTCP Sender Report (тип 200) для видеосендера — шифруется тем же
   * транспортом (AAD — 8-байтовый RTCP-хедер), nonce продолжает счётчик.
   */
  private sendSenderReport(): void {
    if (!this.udp || !this.remote || !this.mode || !this.key) return;
    const header = Buffer.allocUnsafe(8);
    header[0] = 0x80; // версия 2, без padding и приёмных отчётов
    header[1] = 0xc8; // тип 200 — Sender Report
    header.writeUInt16BE(6, 2); // длина всегда 6 32-битных слов
    header.writeUInt32BE(this.videoSsrc >>> 0, 4);

    const ntp = (this.lastPacketTime - NTP_EPOCH_MS) / 1000;
    const ntpMsw = Math.floor(ntp);
    const ntpLsw = Math.min(0xffffffff, Math.round((ntp - ntpMsw) * MAX_UINT32));
    const report = Buffer.allocUnsafe(20);
    report.writeUInt32BE(ntpMsw >>> 0, 0);
    report.writeUInt32BE(ntpLsw >>> 0, 4);
    report.writeUInt32BE(this.rtpTs >>> 0, 8);
    report.writeUInt32BE(this.rtcpPackets >>> 0, 12);
    report.writeUInt32BE(this.rtcpOctets >>> 0, 16);

    this.nonce = (this.nonce + 1) >>> 0;
    const packet = encryptRtpPacket(this.mode, this.key, header, report, this.nonce);
    this.udp.send(packet, this.remote.port, this.remote.ip);
  }

  // ---- voice-gateway ---------------------------------------------------

  private onMessage(data: unknown): void {
    if (typeof data === "string") {
      let packet: { op?: number; d?: Record<string, any> } | null = null;
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
        // Ready: ssrc'ы аудио/видео (streams[0]) и адрес сервера → UDP-хендшейк
        this.resumeAttempts = 0;
        if (this.udp || this.stopped) break;
        this.audioSsrc = Number(d.ssrc ?? 0);
        const stream = Array.isArray(d.streams) ? d.streams[0] : null;
        this.videoSsrc = Number(stream?.ssrc ?? 0);
        this.rtxSsrc = Number(stream?.rtx_ssrc ?? 0);
        if (!this.videoSsrc) {
          this.emit("debug", "stream ready: сервер не выдал video ssrc");
          try {
            this.ws?.close();
          } catch {
            // ignore
          }
          break;
        }
        this.remote = { ip: String(d.ip ?? ""), port: Number(d.port ?? 0) };
        this.createUdp();
        this.startKeepalive();
        void this.selectProtocol(Array.isArray(d.modes) ? d.modes.map(String) : []).catch((err: unknown) => {
          this.emit("debug", `stream udp handshake: ${String(err)}`);
          try {
            this.ws?.close();
          } catch {
            // ignore
          }
        });
        break;
      }
      case 4: {
        // Session description: ключ/режим/DAVE → соединение готово
        if (this.stopped || this.phase === "closed") break;
        const mode = String(d.mode ?? "") as EncryptionMode;
        const secretKey = d.secret_key;
        if (!SUPPORTED_MODES.includes(mode) || !Array.isArray(secretKey) || secretKey.length !== 32) {
          this.emit("debug", `stream: некорректный session description (mode=${mode})`);
          break;
        }
        this.mode = mode;
        this.key = Uint8Array.from(secretKey);
        this.rtpSeq = Math.floor(Math.random() * 0x10000);
        this.rtpTs = Math.floor(Math.random() * 0x1_0000_0000);
        this.nonce = 0;
        this.rtcpPackets = 0;
        this.rtcpOctets = 0;
        this.mediaTsMs = 0;
        this.lastRtcpMs = 0;
        this.resumeAttempts = 0;
        this.dave.init(Number(d.dave_protocol_version ?? 0));
        this.phase = "ready";
        this.announce();
        this.emitStatus();
        break;
      }
      case 5:
      case 9:
        break;
      case 6:
        // heartbeat ack: без сброса счётчика мы сами закроем сессию
        // через ~4 интервала (сервер считает её «мёртвой»)
        this.missed = 0;
        break;
      case 8:
        this.startHeartbeat(Number(d.heartbeat_interval ?? 41250));
        break;
      case 11:
        for (const id of Array.isArray(d.user_ids) ? d.user_ids : []) this.dave.addRecognized(String(id));
        break;
      case 13:
        this.dave.removeRecognized(String(d.user_id ?? ""));
        break;
      case 21: {
        if (this.phase !== "ready") break;
        const transitionId = Number(d.transition_id ?? 0);
        const needsAck = this.dave.prepareTransition(d);
        if (needsAck) this.sendJson(23, { transition_id: transitionId });
        break;
      }
      case 22:
        if (!this.dave.executeTransition(Number(d.transition_id ?? 0))) {
          this.emit("debug", `stream: неизвестный transition ${String(d.transition_id)}`);
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
    if (this.phase !== "ready") return;
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

  /** Анонс потока: speaking=2 (видео) + опкод 12 с параметрами стрима. */
  private announce(): void {
    this.sendJson(5, { speaking: 2, delay: 0, ssrc: this.audioSsrc });
    this.sendJson(12, {
      audio_ssrc: this.audioSsrc,
      video_ssrc: this.videoSsrc,
      rtx_ssrc: this.rtxSsrc,
      streams: [
        {
          type: "video",
          rid: "100",
          ssrc: this.videoSsrc,
          active: true,
          quality: 100,
          rtx_ssrc: this.rtxSsrc,
          max_bitrate: 10_000_000,
          max_framerate: this.opts.video.fps,
          max_resolution: {
            type: "fixed",
            width: this.opts.video.width,
            height: this.opts.video.height,
          },
        },
      ],
    });
  }

  private onClose(code: number): void {
    this.stopHeartbeat();
    if (this.stopped) {
      this.closeUdp();
      return;
    }

    const terminal = code === 4014 || code === 4021 || code === 4022;
    const canResume =
      !terminal &&
      code < 4000 &&
      (this.phase === "ready" || this.phase === "resuming") &&
      this.resumeAttempts < MAX_RESUME_ATTEMPTS;
    if (canResume) {
      // Сбой сети/сервера — пробуем resume, кадры в это время пропускаем
      this.resumeAttempts += 1;
      this.phase = "resuming";
      this.emitStatus();
      const attempt = this.resumeAttempts;
      setTimeout(() => {
        if (!this.stopped && this.phase === "resuming" && this.resumeAttempts === attempt) this.openWs(true);
      }, 400 * attempt);
      return;
    }

    this.phase = "closed";
    this.stopKeepalive();
    this.pendingDiscovery = null;
    this.closeUdp();
    this.emit("close", { code });
  }

  private sendJson(op: number, d: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ op, d }));
    } catch (err) {
      this.emit("debug", `stream send(${op}): ${String(err)}`);
    }
  }

  private sendBinary(op: number, payload: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(Buffer.concat([Buffer.from([op]), payload]));
    } catch (err) {
      this.emit("debug", `stream sendBinary(${op}): ${String(err)}`);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.missed = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.missed >= MAX_MISSED_HEARTBEATS) {
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
    udp.on("error", (err) => this.emit("debug", `stream udp: ${err.message}`));
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

  /** IP-discovery → select protocol (удерживаем H264 в списке кодеков). */
  private async selectProtocol(serverModes: string[]): Promise<void> {
    const mode = chooseMode(serverModes);
    const local = await this.discoverIp();
    if (this.stopped) return;
    this.phase = "selecting";
    this.sendJson(1, {
      protocol: "udp",
      codecs: SELECT_PROTOCOL_CODECS,
      data: { address: local.ip, port: local.port, mode },
    });
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
      const request = Buffer.alloc(74);
      request.writeUInt16BE(1, 0);
      request.writeUInt16BE(70, 2);
      request.writeUInt32BE(this.audioSsrc, 4);
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
    // Прочие пакеты (RTCP сервера) в v1 игнорируем.
  }

  private emitStatus(): void {
    this.emit("status", this.status());
  }
}
