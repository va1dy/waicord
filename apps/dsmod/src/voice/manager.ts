/**
 * VoiceManager — единственная активная голосовая сессия клиента.
 *
 * Слушает VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE от Gateway,
 * собирает из них VoiceConnection и ведёт DTO для UI
 * (фаза, участники канала, DAVE, speaking).
 */
import { EventEmitter } from "node:events";
import type { DscClient } from "../client";
import { toVoiceState } from "../dto";
import { DsmodError, UnauthorizedError } from "../errors";
import type { GatewayClient } from "../gateway";
import type {
  VoiceConnectionDTO,
  VoiceDaveDTO,
  VoicePhase,
  VoiceStateDTO,
  VoiceStreamDTO,
  VoiceStreamPhase,
} from "../types";
import { VoiceConnection } from "./connection";
import { ScreenEncoder, ensureFfmpeg } from "./encoder";
import { StreamConnection } from "./stream";

export interface JoinVoicePayload {
  /** Голосовой канал; для звонка в ЛС — id чата. */
  channelId: string;
  /** Сервер; null — звонок в ЛС. */
  guildId?: string | null;
  selfMute?: boolean;
  selfDeaf?: boolean;
}

/** Параметры запуска Go Live (все опциональны — берутся значения по умолчанию). */
export interface StartStreamPayload {
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  /** "desktop" (весь экран) или заголовок окна, которое захватываем. */
  source?: string;
}

interface JoinConfig {
  guildId: string | null;
  channelId: string;
  selfMute: boolean;
  selfDeaf: boolean;
}

/** Настройки трансляции по умолчанию: 720p30, 2,5 Мбит/с. */
const STREAM_DEFAULTS = { width: 1280, height: 720, fps: 30, bitrateKbps: 2500 };
const STREAM_SIGNAL_TIMEOUT_MS = 15_000;
const STREAM_LIVE_TIMEOUT_MS = 15_000;
const STREAM_STATS_INTERVAL_MS = 1000;

/** Приводим настройки видео к безопасным диапазонам (чётные стороны). */
function normalizeStreamOptions(payload: StartStreamPayload): Required<StartStreamPayload> {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value)));
  const even = (value: number) => Math.round(value / 2) * 2;
  const number = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    width: even(clamp(number(payload.width, STREAM_DEFAULTS.width), 320, 1920)),
    height: even(clamp(number(payload.height, STREAM_DEFAULTS.height), 240, 1080)),
    fps: clamp(number(payload.fps, STREAM_DEFAULTS.fps), 5, 60),
    bitrateKbps: clamp(number(payload.bitrateKbps, STREAM_DEFAULTS.bitrateKbps), 500, 20_000),
    source: payload.source?.trim() || "desktop",
  };
}

const IDLE_DAVE: VoiceDaveDTO = { version: 0, ready: false, privacyCode: "" };

const IDLE_STREAM: VoiceStreamDTO = {
  phase: "idle",
  key: null,
  width: null,
  height: null,
  fps: null,
  bitrateKbps: null,
  ssrc: null,
  mode: null,
  frames: 0,
  bytes: 0,
  startedAt: null,
  error: null,
};

/** Через сколько ждать ответа на op4, прежде чем сдаться (нет прав/тишина). */
const SIGNALING_TIMEOUT_MS = 15_000;

export class VoiceManager extends EventEmitter {
  phase: VoicePhase = "idle";

  private conn: VoiceConnection | null = null;
  private cfg: JoinConfig | null = null;
  private sessionId: string | null = null;
  private server: { token: string; endpoint: string } | null = null;
  private connServerToken: string | null = null;
  private gateway: GatewayClient | null = null;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinAttempts = 0;
  private closeCode: number | null = null;
  private forwardAudio = false;

  // ---- Go Live (трансляция экрана) ------------------------------------
  private stream: StreamConnection | null = null;
  private encoder: ScreenEncoder | null = null;
  private streamCfg: Required<StartStreamPayload> | null = null;
  private streamKey: string | null = null;
  private streamPhase: VoiceStreamPhase = "idle";
  private streamSsrc: number | null = null;
  private streamMode: string | null = null;
  private streamStartedAt: string | null = null;
  private streamError: string | null = null;
  private streamFrames = 0;
  private streamBytes = 0;
  private streamLinkReady = false;
  private streamStatsTimer: ReturnType<typeof setInterval> | null = null;
  /** Собранные dispatch'и стрима в ожидании второй половины (endpoint+token). */
  private streamSignals: {
    serverId: string | null;
    endpoint: string | null;
    token: string | null;
    timer: ReturnType<typeof setTimeout>;
    done: () => void;
  } | null = null;
  /** Резолвер ожидания «live» (соединение + энкодер готовы). */
  private streamLive: { resolve: () => void; reject: (err: Error) => void } | null = null;
  /** Отмена текущего запуска (если stopStream позвали в процессе старта). */
  private abortStreamStart: ((err: Error) => void) | null = null;
  private streamStopped = false;

  private readonly states = new Map<string, Map<string, VoiceStateDTO>>();
  private dave: VoiceDaveDTO = IDLE_DAVE;
  private link: { ssrc: number | null; mode: string | null; speaking: number } = {
    ssrc: null,
    mode: null,
    speaking: 0,
  };

  constructor(private readonly client: DscClient) {
    super();
  }

  /** Текущий канал (null — не в голосе); удобно для «закончить звонок». */
  get channelId(): string | null {
    return this.cfg?.channelId ?? null;
  }

  get audioForwarding(): boolean {
    return this.forwardAudio;
  }

  // ---- подписка на Gateway --------------------------------------------

  /** Вызывается из DscClient.connect() — вешаемся на свежий Gateway. */
  attach(gateway: GatewayClient): void {
    if (this.gateway === gateway) return;
    this.detach();
    this.gateway = gateway;
    gateway.on("VOICE_STATE_UPDATE", this.onVoiceStateUpdate);
    gateway.on("VOICE_SERVER_UPDATE", this.onVoiceServerUpdate);
    gateway.on("ready", this.onGatewayReady);
    gateway.on("STREAM_CREATE", this.onStreamCreate);
    gateway.on("STREAM_SERVER_UPDATE", this.onStreamServerUpdate);
    gateway.on("STREAM_DELETE", this.onStreamDelete);
  }

  detach(): void {
    if (!this.gateway) return;
    this.gateway.off("VOICE_STATE_UPDATE", this.onVoiceStateUpdate);
    this.gateway.off("VOICE_SERVER_UPDATE", this.onVoiceServerUpdate);
    this.gateway.off("ready", this.onGatewayReady);
    this.gateway.off("STREAM_CREATE", this.onStreamCreate);
    this.gateway.off("STREAM_SERVER_UPDATE", this.onStreamServerUpdate);
    this.gateway.off("STREAM_DELETE", this.onStreamDelete);
    this.gateway = null;
  }

  /** Полный останов (gateway уходит) — сброс без отправки op4. */
  stop(): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.signalTimer = null;
    this.detach();
    this.stopStreamState();
    this.conn?.destroy();
    this.conn = null;
    this.connServerToken = null;
    this.cfg = null;
    this.sessionId = null;
    this.server = null;
    this.states.clear();
    this.closeCode = null;
    this.dave = IDLE_DAVE;
    this.link = { ssrc: null, mode: null, speaking: 0 };
    this.phase = "idle";
  }

  // ---- публичные операции ---------------------------------------------

  /** Войти в голосовой канал / начать звонок в ЛС. */
  async join(payload: JoinVoicePayload): Promise<VoiceConnectionDTO> {
    if (!this.client.isAuthenticated) throw new UnauthorizedError();
    if (!this.client.me) await this.client.loadMe();

    const gateway = this.client.gateway;
    if (!gateway || gateway.status !== "ready") {
      throw new DsmodError("gateway_required", "Gateway не подключён — дождись статуса ready (GET /api/health)");
    }
    if (this.cfg) await this.leave();

    this.cfg = {
      guildId: payload.guildId ?? null,
      channelId: String(payload.channelId),
      selfMute: Boolean(payload.selfMute),
      selfDeaf: Boolean(payload.selfDeaf),
    };
    this.sessionId = null;
    this.server = null;
    this.closeCode = null;
    this.rejoinAttempts = 0;
    this.phase = "signalling";
    this.emitStatus();
    this.sendVoiceState();
    // если Discord не ответил (нет прав на канал) — выходим из signalling
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.signalTimer = setTimeout(() => {
      this.signalTimer = null;
      if (this.phase !== "signalling") return;
      this.resetJoinState();
      this.phase = "disconnected";
      this.closeCode = null;
      this.emitStatus();
    }, SIGNALING_TIMEOUT_MS);
    return this.status();
  }

  /** Выйти из канала / закончить звонок. */
  async leave(): Promise<VoiceConnectionDTO> {
    if (this.cfg && this.gateway) {
      this.gateway.send(4, {
        guild_id: this.cfg.guildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      });
    }
    this.resetJoinState();
    this.phase = "idle";
    this.emitStatus();
    return this.status();
  }

  /** Обновить self_mute / self_deaf в активном подключении. */
  setState(patch: { selfMute?: boolean; selfDeaf?: boolean }): VoiceConnectionDTO {
    if (!this.cfg) throw new DsmodError("not_in_voice", "Нет активного подключения — сначала POST /api/voice/join");
    if (patch.selfMute !== undefined) this.cfg.selfMute = patch.selfMute;
    if (patch.selfDeaf !== undefined) this.cfg.selfDeaf = patch.selfDeaf;
    this.sendVoiceState();
    return this.status();
  }

  /** Флаги speaking (1 — голос, 0 — тишина). */
  setSpeaking(flags: number | boolean): void {
    if (!this.conn) throw new DsmodError("not_in_voice", "Нет активного подключения — сначала POST /api/voice/join");
    this.conn.setSpeaking(flags);
  }

  /** PCM (base64 уже декодирован снаружи) → канал. Число отправленных фреймов. */
  sendPcm(pcm: Buffer): number {
    if (!this.conn || this.phase !== "ready") {
      throw new DsmodError("not_in_voice", "Нет активного подключения — сначала POST /api/voice/join");
    }
    return this.conn.sendPcm(pcm);
  }

  /** Пересылать ли декодированное входящее аудио в UI (DSMOD_VOICE_AUDIO). */
  setForwardAudio(enabled: boolean): void {
    this.forwardAudio = enabled;
  }

  // ---- Go Live (трансляция экрана) --------------------------------------

  /**
   * Запустить трансляцию экрана (Go Live) в текущем серверном канале.
   *
   * Требуется активное голосовое подключение (Discord не принимает стрим
   * без него). Сигналинг: op18 STREAM_CREATE → dispatch'и STREAM_CREATE
   * (rtc_server_id) и STREAM_SERVER_UPDATE (endpoint, token) →
   * стрим-соединение (StreamConnection) → op22 «не на паузе» → кадры
   * из ffmpeg (ScreenEncoder) уходят RTP-пакетами.
   */
  async startStream(payload: StartStreamPayload = {}): Promise<VoiceConnectionDTO> {
    if (!this.client.isAuthenticated) throw new UnauthorizedError();
    const gateway = this.client.gateway;
    if (!gateway || gateway.status !== "ready") {
      throw new DsmodError("gateway_required", "Gateway не подключён — дождись статуса ready (GET /api/health)");
    }
    const cfg = this.cfg;
    if (!cfg || this.phase !== "ready") {
      throw new DsmodError("not_in_voice", "Сначала войдите в голосовой канал (POST /api/voice/join)");
    }
    if (!cfg.guildId) {
      throw new DsmodError("invalid_body", "Go Live доступен только в серверных каналах (не для звонков в ЛС)");
    }
    if (!this.sessionId) {
      throw new DsmodError("not_in_voice", "Нет session_id голосовой сессии — переподключитесь к каналу");
    }
    if (this.stream || this.streamPhase !== "idle") {
      throw new DsmodError("conflict", "Трансляция уже идёт — сначала POST /api/voice/stream/stop");
    }
    if (!this.client.me) await this.client.loadMe();
    const me = this.client.me;
    if (!me) throw new UnauthorizedError();

    const video = normalizeStreamOptions(payload);
    const sessionId = this.sessionId;
    this.streamStopped = false;
    this.streamCfg = video;
    this.streamError = null;
    this.streamFrames = 0;
    this.streamBytes = 0;
    this.streamSsrc = null;
    this.streamMode = null;
    this.streamStartedAt = null;
    this.streamPhase = "signalling";
    this.emitStatus();

    try {
      // ffmpeg нужен до сигналинга: первая установка (~200 МБ) может занять
      // минуты, а токен стрима живёт недолго
      const exe = await ensureFfmpeg((line) => this.emit("debug", line));

      const signals = await this.waitForStreamSignals(gateway, `guild:${cfg.guildId}:${cfg.channelId}:${me.id}`);
      const conn = new StreamConnection({
        serverId: signals.serverId,
        guildId: cfg.guildId,
        channelId: cfg.channelId,
        token: signals.token,
        endpoint: signals.endpoint,
        sessionId,
        userId: me.id,
        video: { width: video.width, height: video.height, fps: video.fps },
      });
      this.stream = conn;
      this.streamPhase = "connecting";
      this.emitStatus();

      conn.on("status", (link: { phase: string; ssrc: number | null; mode: string | null }) => {
        if (this.stream !== conn) return;
        this.streamSsrc = link.ssrc;
        this.streamMode = link.mode;
        if (link.phase === "ready") this.onStreamLinkReady(conn, exe);
        this.emitStatus();
      });
      conn.on("debug", (message: string) => this.emit("debug", `Go Live: ${message}`));
      conn.on("close", (info: { code: number }) => this.onStreamLinkClose(conn, info));
      conn.start();

      await this.waitForStreamLive();
      this.streamPhase = "live";
      this.streamStartedAt = new Date().toISOString();
      this.startStreamStats();
      this.emitStatus();
      return this.status();
    } catch (err) {
      if (this.streamStopped) {
        // трансляцию остановили во время запуска — состояние уже сброшено
        this.streamStopped = false;
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const failure = err instanceof DsmodError ? err : new DsmodError("stream_failed", `Не удалось запустить трансляцию: ${message}`);
      this.failStream(failure.message);
      throw failure;
    }
  }

  /** Остановить трансляцию (если шла) — DELETE не нужен, шлём op19 сами. */
  stopStream(): VoiceConnectionDTO {
    this.stopStreamState();
    this.emitStatus();
    return this.status();
  }

  /** Состояние подключения + участники текущего канала. */
  status(): VoiceConnectionDTO {
    const channelId = this.cfg?.channelId ?? null;
    return {
      phase: this.phase,
      guildId: this.cfg?.guildId ?? null,
      channelId,
      ssrc: this.link.ssrc,
      mode: this.link.mode,
      speaking: this.link.speaking,
      closeCode: this.closeCode,
      dave: this.conn ? this.dave : IDLE_DAVE,
      participants: channelId ? [...(this.states.get(channelId)?.values() ?? [])] : [],
      stream: this.streamStatus(),
    };
  }

  // ---- внутреннее ------------------------------------------------------

  private resetJoinState(): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.signalTimer = null;
    this.stopStreamState();
    this.cfg = null;
    this.sessionId = null;
    this.server = null;
    this.connServerToken = null;
    this.rejoinAttempts = 0;
    this.closeCode = null;
    this.dave = IDLE_DAVE;
    this.link = { ssrc: null, mode: null, speaking: 0 };
    this.conn?.destroy();
    this.conn = null;
  }

  private sendVoiceState(): void {
    if (!this.cfg || !this.gateway) return;
    this.gateway.send(4, {
      guild_id: this.cfg.guildId,
      channel_id: this.cfg.channelId,
      self_mute: this.cfg.selfMute,
      self_deaf: this.cfg.selfDeaf,
    });
  }

  /** Обе половины (session_id + endpoint/token) есть → поднимаем соединение. */
  private maybeConnect(): void {
    const cfg = this.cfg;
    const server = this.server;
    if (!cfg || !this.sessionId || !server) return;
    if (this.conn && this.connServerToken === server.token) return;

    const me = this.client.me;
    if (!me) return;
    this.conn?.destroy();
    this.conn = null;

    const conn = new VoiceConnection({
      serverId: cfg.guildId ?? cfg.channelId,
      channelId: cfg.channelId,
      guildId: cfg.guildId,
      token: server.token,
      endpoint: server.endpoint,
      sessionId: this.sessionId,
      userId: me.id,
    });
    this.conn = conn;
    this.connServerToken = server.token;
    this.phase = "connecting";
    this.dave = IDLE_DAVE;

    conn.on("status", (link) => {
      this.link = { ssrc: link.ssrc, mode: link.mode, speaking: link.speaking };
      if (link.phase === "ready") {
        this.phase = "ready";
        this.rejoinAttempts = 0;
        this.closeCode = null;
      } else if (link.phase === "resuming") {
        this.phase = "reconnecting";
      } else if (link.phase !== "closed") {
        this.phase = "connecting";
      }
      this.emitStatus();
    });
    conn.on("dave", (state: VoiceDaveDTO) => {
      this.dave = state;
      this.emit("dave", state);
    });
    conn.on("speaking", (event: { userId: string; ssrc: number; speaking: number }) => this.emit("speaking", event));
    conn.on("audio", (event: { userId: string; pcm: Buffer }) => {
      if (this.forwardAudio) this.emit("audio", event);
    });
    conn.on("debug", (message: string) => this.emit("debug", message));
    conn.on("close", (info: { code: number; terminal: boolean }) => this.onConnectionClose(info));

    conn.start();
    this.emitStatus();
  }

  private onConnectionClose(info: { code: number; terminal: boolean }): void {
    this.conn = null;
    this.connServerToken = null;
    this.closeCode = info.code;

    if (info.terminal || !this.cfg || this.rejoinAttempts >= 3) {
      // 4014/4021/4022 или лимит попыток — выходим из голоса
      this.resetJoinState();
      this.phase = "disconnected";
      this.emitStatus();
      return;
    }

    this.rejoinAttempts += 1;
    this.phase = "reconnecting";
    this.sessionId = null;
    this.server = null;
    this.emitStatus();
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      this.sendVoiceState();
    }, 400 * this.rejoinAttempts);
  }

  // ---- внутреннее: Go Live ---------------------------------------------

  /** Ждём обе половины сигналинга: STREAM_CREATE и STREAM_SERVER_UPDATE. */
  private waitForStreamSignals(
    gateway: GatewayClient,
    key: string,
  ): Promise<{ serverId: string; endpoint: string; token: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streamSignals = null;
        this.abortStreamStart = null;
        reject(new DsmodError("stream_timeout", "Discord не ответил на запрос трансляции (нет права на Go Live?)"));
      }, STREAM_SIGNAL_TIMEOUT_MS);
      this.streamKey = key;
      this.streamSignals = {
        serverId: null,
        endpoint: null,
        token: null,
        timer,
        done: () => {
          const signals = this.streamSignals;
          if (!signals?.serverId || !signals.endpoint || !signals.token) return;
          clearTimeout(signals.timer);
          this.streamSignals = null;
          this.abortStreamStart = null;
          resolve({ serverId: signals.serverId, endpoint: signals.endpoint, token: signals.token });
        },
      };
      this.abortStreamStart = (err) => {
        if (this.streamSignals) clearTimeout(this.streamSignals.timer);
        this.streamSignals = null;
        reject(err);
      };
      gateway.send(18, {
        type: "guild",
        guild_id: this.cfg?.guildId ?? null,
        channel_id: this.cfg?.channelId ?? null,
        preferred_region: null,
      });
    });
  }

  /** Ждём, пока стрим-соединение станет ready и запустится энкодер. */
  private waitForStreamLive(): Promise<void> {
    if (this.streamLinkReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streamLive = null;
        this.abortStreamStart = null;
        reject(new DsmodError("stream_timeout", "Стрим-соединение не установилось за 15 с"));
      }, STREAM_LIVE_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.streamLive = null;
        this.abortStreamStart = null;
        fn();
      };
      this.streamLive = {
        resolve: () => settle(resolve),
        reject: (err: Error) => settle(() => reject(err)),
      };
      this.abortStreamStart = (err: Error) => settle(() => reject(err));
    });
  }

  /** Стрим-соединение готово: op22 «не на паузе» + запуск ffmpeg. */
  private onStreamLinkReady(conn: StreamConnection, ffmpegExe: string): void {
    if (this.stream !== conn || this.encoder) return;
    try {
      this.gateway?.send(22, { stream_key: this.streamKey, paused: false });
      const cfg = this.streamCfg ?? { ...STREAM_DEFAULTS, source: "desktop" };
      const encoder = new ScreenEncoder(cfg);
      this.encoder = encoder;
      const frametimeMs = encoder.frametimeMs;
      encoder.on("frame", (frame: Buffer) => {
        if (this.stream !== conn) return;
        if (conn.sendVideoFrame(frame, frametimeMs)) {
          this.streamFrames = conn.frames;
          this.streamBytes = conn.bytes;
        }
      });
      encoder.on("error", (err: Error) => this.emit("debug", `Go Live: ffmpeg: ${err.message}`));
      encoder.on("exit", (info: { code: number | null }) => this.onStreamEncoderExit(conn, encoder, info));
      encoder.start(ffmpegExe);
      this.streamLinkReady = true;
      this.streamLive?.resolve();
    } catch (err) {
      this.streamLive?.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** ffmpeg умер сам — трансляция кончилась. */
  private onStreamEncoderExit(conn: StreamConnection, encoder: ScreenEncoder, info: { code: number | null }): void {
    if (this.encoder !== encoder || this.stream !== conn) return;
    const tail = encoder.lastError();
    if (tail) this.emit("debug", `Go Live: ffmpeg stderr: ${tail}`);
    this.failStream(`ffmpeg завершился (код ${info.code})`);
  }

  private onStreamLinkClose(conn: StreamConnection, info: { code: number }): void {
    if (this.stream !== conn) return;
    this.failStream(`стрим-соединение закрыто (код ${info.code})`);
  }

  /** Трансляция сорвалась: гасим локальные ресурсы, op19, фаза «error». */
  private failStream(message: string): void {
    if (this.streamPhase === "error" && !this.stream && !this.encoder) return;
    this.emit("debug", `Go Live: ${message}`);
    const key = this.streamKey;
    const live = this.streamLive;
    this.teardownStream();
    if (key && this.gateway?.status === "ready") this.gateway.send(19, { stream_key: key });
    this.streamKey = null;
    this.streamPhase = "error";
    this.streamError = message;
    this.streamSsrc = null;
    this.streamMode = null;
    this.streamSignals = null;
    this.streamLive = null;
    this.abortStreamStart = null;
    live?.reject(new DsmodError("stream_failed", message));
    this.emitStatus();
  }

  /** Погасить ffmpeg и стрим-соединение (без op19 и без emit). */
  private teardownStream(): void {
    if (this.streamStatsTimer) clearInterval(this.streamStatsTimer);
    this.streamStatsTimer = null;
    const encoder = this.encoder;
    this.encoder = null;
    encoder?.stop();
    const conn = this.stream;
    this.stream = null;
    conn?.destroy();
  }

  /** Остановка трансляции (op19 + локальная уборка), состояние → idle. */
  private stopStreamState(): void {
    this.streamStopped = true;
    this.abortStreamStart?.(new DsmodError("conflict", "запуск трансляции остановлен"));
    const key = this.streamKey;
    this.teardownStream();
    if (key && this.gateway?.status === "ready") this.gateway.send(19, { stream_key: key });
    this.clearStreamState();
  }

  private clearStreamState(): void {
    this.streamCfg = null;
    this.streamKey = null;
    this.streamPhase = "idle";
    this.streamSsrc = null;
    this.streamMode = null;
    this.streamStartedAt = null;
    this.streamError = null;
    this.streamFrames = 0;
    this.streamBytes = 0;
    this.streamLinkReady = false;
    this.streamSignals = null;
    this.streamLive = null;
    this.abortStreamStart = null;
  }

  /** Раз в секунду обновляем UI счётчиками кадров/байт. */
  private startStreamStats(): void {
    if (this.streamStatsTimer) clearInterval(this.streamStatsTimer);
    this.streamStatsTimer = setInterval(() => {
      if (this.streamPhase === "live") this.emitStatus();
    }, STREAM_STATS_INTERVAL_MS);
  }

  private streamStatus(): VoiceStreamDTO {
    return {
      phase: this.streamPhase,
      key: this.streamKey,
      width: this.streamCfg?.width ?? null,
      height: this.streamCfg?.height ?? null,
      fps: this.streamCfg?.fps ?? null,
      bitrateKbps: this.streamCfg?.bitrateKbps ?? null,
      ssrc: this.streamSsrc,
      mode: this.streamMode,
      frames: this.streamFrames,
      bytes: this.streamBytes,
      startedAt: this.streamStartedAt,
      error: this.streamError,
    };
  }

  private readonly onStreamCreate = (d: Record<string, any>) => {
    const key = d?.stream_key ? String(d.stream_key) : null;
    this.emit("debug", `Go Live: STREAM_CREATE (key=${key ?? "?"}, rtc_server_id=${d?.rtc_server_id ?? "?"})`);
    const signals = this.streamSignals;
    if (!signals) return;
    if (key && this.streamKey && key !== this.streamKey) return;
    signals.serverId = d?.rtc_server_id ? String(d.rtc_server_id) : null;
    if (signals.serverId) signals.done();
  };

  private readonly onStreamServerUpdate = (d: Record<string, any>) => {
    const endpoint = d?.endpoint ? String(d.endpoint) : null;
    this.emit("debug", `Go Live: STREAM_SERVER_UPDATE (endpoint=${endpoint ?? "?"})`);
    const signals = this.streamSignals;
    if (!signals || !endpoint) return;
    signals.endpoint = endpoint;
    signals.token = String(d?.token ?? "");
    signals.done();
  };

  private readonly onStreamDelete = (d: Record<string, any>) => {
    const key = d?.stream_key ? String(d.stream_key) : null;
    this.emit("debug", `Go Live: STREAM_DELETE (key=${key ?? "?"})`);
    if (key && this.streamKey && key !== this.streamKey) return;
    if (this.stream) {
      this.failStream("Discord завершил трансляцию");
      return;
    }
    if (this.streamPhase === "signalling") {
      this.abortStreamStart?.(new DsmodError("stream_failed", "Discord завершил трансляцию"));
    }
  };

  private readonly onVoiceStateUpdate = (d: Record<string, any>) => {
    const userId = String(d.user_id ?? "");
    if (!userId) return;
    this.trackVoiceState(d);

    if (userId !== this.client.me?.id) return;

    const channelId = d.channel_id ? String(d.channel_id) : null;
    if (!channelId) {
      // нас выкинули/вышли сами (после нашего leave() cfg уже сброшен)
      if (this.cfg) {
        this.resetJoinState();
        this.phase = "disconnected";
        this.emitStatus();
      }
      return;
    }

    this.sessionId = String(d.session_id ?? "");
    if (this.cfg && this.cfg.channelId !== channelId) {
      // нас перенесли в другой канал — переподключаемся
      this.cfg = { ...this.cfg, channelId };
      this.server = null;
      this.conn?.destroy();
      this.conn = null;
      this.connServerToken = null;
    }
    this.maybeConnect();
    this.emitStatus();
  };

  private readonly onVoiceServerUpdate = (d: Record<string, any>) => {
    if (!this.cfg) return;
    const endpoint = d.endpoint ? String(d.endpoint) : null;
    if (!endpoint) return; // эндпоинт убрали — ждём следующего события
    this.server = { token: String(d.token ?? ""), endpoint };
    this.maybeConnect();
  };

  private readonly onGatewayReady = (d: Record<string, any>) => {
    // стартовые голосовые состояния всех серверов
    for (const vs of Array.isArray(d?.voice_states) ? d.voice_states : []) {
      if (vs?.user_id && vs?.channel_id) this.trackVoiceState(vs);
    }
  };

  /** Копим голосовые состояния участников по каналам (для participants). */
  private trackVoiceState(d: Record<string, any>): void {
    const userId = String(d.user_id ?? "");
    if (!userId) return;
    const channelId = d.channel_id ? String(d.channel_id) : null;

    for (const [chId, members] of this.states) {
      if (chId !== channelId && members.delete(userId) && members.size === 0) this.states.delete(chId);
    }
    if (!channelId) return;

    let members = this.states.get(channelId);
    if (!members) {
      members = new Map();
      this.states.set(channelId, members);
    }
    members.set(userId, toVoiceState(d));
  }

  private emitStatus(): void {
    this.emit("status", this.status());
  }
}
