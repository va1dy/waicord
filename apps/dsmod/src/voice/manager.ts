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
import type { VoiceConnectionDTO, VoiceDaveDTO, VoicePhase, VoiceStateDTO } from "../types";
import { VoiceConnection } from "./connection";

export interface JoinVoicePayload {
  /** Голосовой канал; для звонка в ЛС — id чата. */
  channelId: string;
  /** Сервер; null — звонок в ЛС. */
  guildId?: string | null;
  selfMute?: boolean;
  selfDeaf?: boolean;
}

interface JoinConfig {
  guildId: string | null;
  channelId: string;
  selfMute: boolean;
  selfDeaf: boolean;
}

const IDLE_DAVE: VoiceDaveDTO = { version: 0, ready: false, privacyCode: "" };

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
  }

  detach(): void {
    if (!this.gateway) return;
    this.gateway.off("VOICE_STATE_UPDATE", this.onVoiceStateUpdate);
    this.gateway.off("VOICE_SERVER_UPDATE", this.onVoiceServerUpdate);
    this.gateway.off("ready", this.onGatewayReady);
    this.gateway = null;
  }

  /** Полный останов (gateway уходит) — сброс без отправки op4. */
  stop(): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.signalTimer = null;
    this.detach();
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
    };
  }

  // ---- внутреннее ------------------------------------------------------

  private resetJoinState(): void {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.signalTimer) clearTimeout(this.signalTimer);
    this.signalTimer = null;
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
