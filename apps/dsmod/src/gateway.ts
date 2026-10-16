import { EventEmitter } from "node:events";
import { wsInit } from "./net";

export type GatewayStatus = "idle" | "connecting" | "ready" | "resumed" | "reconnecting" | "closed";

export interface GatewayOptions {
  token: string;
  apiVersion?: number;
  userAgent?: string;
  properties?: Record<string, unknown>;
  locale?: string;
  /** true, если токен бота — тогда вместо capabilities шлём intents. */
  bot?: boolean;
  /** Intents для бота (для user-сессии не используются). */
  intents?: number;
  /** Автоматически переподключаться при обрыве. */
  autoReconnect?: boolean;
}

/** Стандартные intents бота: серверы, сообщения, ЛС, содержимое сообщений. */
export const DEFAULT_BOT_INTENTS = 1 | 512 | 1024 | 4096 | 32768;

/** Capabilities, которые шлёт официальный десктоп/web клиент. */
const DEFAULT_CAPABILITIES = 30717;

interface Packet {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}

/**
 * Discord Gateway (WebSocket) — источник живых событий: MESSAGE_CREATE,
 * TYPING_START, PRESENCE_UPDATE и т.д.
 *
 * Спецификация: https://discord.com/developers/docs/events/gateway
 */
export class GatewayClient extends EventEmitter {
  status: GatewayStatus = "idle";
  sessionId: string | null = null;
  sequence: number | null = null;
  eventsReceived = 0;
  reconnects = 0;
  lastEventAt: string | null = null;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatStartTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAck = true;
  private resumeUrl: string | null = null;
  private stopped = false;
  private attempt = 0;
  private readonly options: Required<Omit<GatewayOptions, "token">> & { token: string };

  constructor(options: GatewayOptions) {
    super();
    this.options = {
      token: options.token,
      apiVersion: options.apiVersion ?? 9,
      userAgent: options.userAgent ?? "",
      locale: options.locale ?? "en-US",
      bot: options.bot ?? false,
      intents: options.intents ?? DEFAULT_BOT_INTENTS,
      autoReconnect: options.autoReconnect ?? true,
      properties: options.properties ?? {},
    };
  }

  private get gatewayUrl(): string {
    const base = this.resumeUrl ?? "wss://gateway.discord.gg/";
    const url = new URL(base);
    url.searchParams.set("v", String(this.options.apiVersion));
    url.searchParams.set("encoding", "json");
    return url.toString();
  }

  /** Открывает соединение; резолвится после READY (или RESUMED). */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.open();
  }

  /** Закрывает соединение без автопереподключения. */
  disconnect(code = 1000): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.ws?.close(code);
    this.ws = null;
    this.setStatus("closed");
    this.emit("close", { code });
  }

  /** Отправить событие в Gateway (например presence). */
  send(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  /** Обновить статус/активность — op 3 (PRESENCE_UPDATE). */
  setPresence(presence: { status?: string; activities?: unknown[]; since?: number | null; afk?: boolean }): void {
    this.send(3, {
      since: presence.since ?? null,
      activities: presence.activities ?? [],
      status: presence.status ?? "online",
      afk: presence.afk ?? false,
    });
  }

  private open(): Promise<void> {
    this.setStatus(this.sessionId ? "reconnecting" : "connecting");
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const ws = new WebSocket(this.gatewayUrl, {
        headers: {
          "User-Agent": this.options.userAgent,
          "Accept-Encoding": "gzip, deflate, br",
        },
        ...wsInit(),
      } as any);
      this.ws = ws;

      ws.onopen = () => this.emit("debug", "gateway open");
      ws.onerror = () => onError(new Error("Gateway connection error"));
      ws.onclose = (event: CloseEvent) => {
        this.stopHeartbeat();
        this.emit("debug", `gateway closed (${event?.code ?? "?"})`);
        if (this.stopped) return;
        // не успели получить READY — отдаём ошибку вызывающему, он сам повторит
        if (!settled) {
          onError(new Error(`Gateway closed before READY (code ${event?.code ?? "?"})`));
          return;
        }
        void this.reconnect(event?.code ?? 1006);
      };
      ws.onmessage = (event: MessageEvent) => {
        let packet: Packet;
        try {
          packet = JSON.parse(String(event.data));
        } catch {
          return;
        }
        this.handle(packet, onReady, onError);
      };
    });
  }

  private handle(packet: Packet, onReady: () => void, onError: (err: Error) => void) {
    if (packet.s !== undefined && packet.s !== null) this.sequence = packet.s;

    switch (packet.op) {
      case 10: {
        // Hello → heartbeat + identify/resume
        this.startHeartbeat(Number(packet.d?.heartbeat_interval ?? 41_250));
        if (this.sessionId && this.sequence !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }
      case 1: {
        // сервер попросил heartbeat прямо сейчас
        this.sendHeartbeat();
        break;
      }
      case 11: {
        this.heartbeatAck = true;
        break;
      }
      case 7: {
        // Reconnect → пробуем resume на другом сокете
        this.emit("debug", "gateway asked to reconnect");
        this.ws?.close(4000);
        break;
      }
      case 9: {
        // Invalid Session
        const resumable = packet.d === true && this.sessionId !== null;
        this.emit("debug", `invalid session (resumable=${resumable})`);
        if (!resumable) {
          this.sessionId = null;
          this.sequence = null;
        }
        setTimeout(() => this.ws?.close(4001), 1000 + Math.random() * 4000);
        break;
      }
      case 0: {
        this.dispatch(packet, onReady, onError);
        break;
      }
      default:
        break;
    }
  }

  private dispatch(packet: Packet, onReady: () => void, onError: (err: Error) => void) {
    const t = String(packet.t ?? "");
    const d = packet.d;

    if (t === "READY") {
      this.sessionId = d?.session_id ?? null;
      this.resumeUrl = d?.resume_gateway_url ?? null;
      this.attempt = 0;
      this.setStatus("ready");
      this.emit("ready", d);
      onReady();
    } else if (t === "RESUMED") {
      this.attempt = 0;
      this.setStatus("resumed");
      this.emit("resumed", d);
      onReady();
    } else if (t) {
      this.eventsReceived += 1;
      this.lastEventAt = new Date().toISOString();
      this.emit("event", { t, d, s: packet.s ?? null });
      this.emit(t, d);
    }

    if (packet.op === 0 && this.status === "connecting" && !this.sessionId) {
      onError(new Error(`Gateway не вернул READY (последнее событие: ${t || "нет"})`));
    }
  }

  private sendIdentify() {
    const d: Record<string, unknown> = {
      token: this.options.token,
      properties: this.options.properties,
      presence: { activities: [], status: "online", since: null, afk: false },
      compress: false,
      client_state: { guild_versions: {} },
    };
    if (this.options.bot) {
      d.intents = this.options.intents;
    } else {
      d.capabilities = DEFAULT_CAPABILITIES;
    }
    this.send(2, d);
  }

  private sendResume() {
    this.send(6, { token: this.options.token, session_id: this.sessionId, seq: this.sequence });
  }

  private sendHeartbeat() {
    this.send(1, this.sequence);
    this.heartbeatAck = false;
  }

  private startHeartbeat(intervalMs: number) {
    this.stopHeartbeat();
    // первый heartbeat — со случайным jitter (0..1), дальше каждые interval
    const jitter = intervalMs * Math.random();
    this.heartbeatStartTimer = setTimeout(() => {
      this.heartbeatStartTimer = null;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeatAck) {
          this.emit("debug", "heartbeat not acknowledged — reconnecting");
          this.ws?.close(4002);
          return;
        }
        this.sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatStartTimer) clearTimeout(this.heartbeatStartTimer);
    this.heartbeatTimer = null;
    this.heartbeatStartTimer = null;
  }

  private async reconnect(code: number) {
    if (!this.options.autoReconnect) {
      this.setStatus("closed");
      return;
    }
    // коды 4004 (auth failed) / 4010-4014 — переподключение не поможет
    if (code === 4004 || (code >= 4010 && code <= 4014)) {
      this.setStatus("closed");
      this.emit("fatal", { code });
      return;
    }
    this.reconnects += 1;
    this.setStatus("reconnecting");
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) + Math.random() * 1000;
    this.emit("reconnecting", { code, attempt: this.attempt, delay });
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopped) return;
    try {
      await this.open();
    } catch (err) {
      this.emit("error", err);
      void this.reconnect(1006);
    }
  }

  private setStatus(status: GatewayStatus) {
    this.status = status;
    this.emit("status", status);
  }
}
