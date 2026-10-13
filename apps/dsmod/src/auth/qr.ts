import { EventEmitter } from "node:events";
import { constants, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { DEFAULT_USER_AGENT } from "../config";
import type { DiscordRest } from "../http/client";
import type { QrStateDTO, QrStatus } from "../types";

const GATEWAY_URL = "wss://remote-auth-gateway.discord.gg/?v=2";
const QR_PREFIX = "https://discord.com/ra/";

export interface QrOptions {
  userAgent?: string;
  /** Сколько ждать сканирования, мс (по умолчанию 120 000). */
  timeoutMs?: number;
}

export interface QrEventMap {
  /** Появился URL для QR-кода — можно рисовать. */
  ready: [state: QrStateDTO];
  /** QR отсканировали (показать «Подтвердите вход на устройстве X»). */
  scanned: [state: QrStateDTO];
  /** Пользователь подтвердил вход — здесь лежит токен. */
  token: [token: string];
  cancelled: [state: QrStateDTO];
  timeout: [state: QrStateDTO];
  error: [error: Error];
  close: [];
}

/**
 * Вход по QR-коду («Войти на другом устройстве»).
 *
 * Как это работает (remote-auth gateway, v2):
 *  1. WS connect → сервер шлёт `hello` (heartbeat_interval, timeout_ms);
 *  2. клиент генерирует RSA-2048 пару и шлёт `init` с публичным ключом;
 *  3. сервер отвечает `pending_remote_init` c fingerprint → это и есть QR: https://discord.com/ra/<fingerprint>;
 *  4. `nonce_proof` → расшифровать nonce приватным ключом, посчитать sha256 и вернуть proof;
 *  5. `pending_ticket` → пользователь отсканировал (в payload лежит id/username);
 *  6. `pending_login` → обменять ticket на токен через POST /users/@me/remote-auth/login.
 */
export class QrSession extends EventEmitter {
  status: QrStatus = "idle";
  url: string | null = null;
  fingerprint: string | null = null;
  expiresAt: string | null = null;
  user: { id: string; username: string } | null = null;
  token: string | null = null;
  error: string | null = null;

  private ws: WebSocket | null = null;
  /** PEM-ключ (pkcs8) — им расшифровываем nonce/user/token от gateway. */
  private privateKey: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    private readonly rest: DiscordRest,
    private readonly options: QrOptions = {},
  ) {
    super();
    // дефолтный слушатель, чтобы 'error' без подписчиков не ронял процесс
    this.on("error", () => undefined);
  }

  override on<K extends keyof QrEventMap>(event: K, listener: (...args: QrEventMap[K]) => void): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof QrEventMap>(event: K, listener: (...args: QrEventMap[K]) => void): this {
    return super.once(event as string, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof QrEventMap>(event: K, listener: (...args: QrEventMap[K]) => void): this {
    return super.off(event as string, listener as (...args: unknown[]) => void);
  }

  /** Открывает сессию и резолвится, когда появился `url` для QR-кода. */
  async start(): Promise<string> {
    if (this.started) {
      if (!this.url) throw new Error("QR session already started");
      return this.url;
    }
    this.started = true;

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    this.privateKey = privateKey;
    const encodedPublicKey = Buffer.from(publicKey).toString("base64");

    const timeoutMs = this.options.timeoutMs ?? 120_000;

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.fail(err);
        reject(err);
      };
      const ready = (url: string) => {
        if (settled) return;
        settled = true;
        resolve(url);
      };

      // Bun подставляет заголовки в WebSocket — Discord ждёт Origin/User-Agent
      const ws = new WebSocket(GATEWAY_URL, {
        headers: {
          Origin: "https://discord.com",
          "User-Agent": this.options.userAgent ?? DEFAULT_USER_AGENT,
        },
      } as any);
      this.ws = ws;

      ws.onopen = () => {
        // ждём hello — ключи отправим там (см. handle)
      };

      ws.onerror = () => fail(new Error("Remote-auth gateway connection error"));

      ws.onclose = (event: CloseEvent) => {
        this.stopTimers();
        if (this.status === "idle" || this.status === "waiting") {
          fail(new Error(`Remote-auth gateway closed before login (code ${event?.code ?? "?"})`));
        } else if (this.status === "scanned") {
          this.setStatus("cancelled");
          this.emit("cancelled", this.state());
          if (!settled) fail(new Error("QR session closed before confirmation"));
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        let payload: any;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        try {
          this.handle(payload, encodedPublicKey, ready, fail, timeoutMs);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };
    });
  }

  /** Резолвится токеном после подтверждения входа на телефоне. */
  waitForToken(): Promise<string> {
    if (this.token) return Promise.resolve(this.token);
    if (this.status === "cancelled" || this.status === "expired" || this.status === "error") {
      return Promise.reject(new Error(this.error ?? `QR session is ${this.status}`));
    }
    return new Promise<string>((resolve, reject) => {
      this.once("token", resolve);
      this.once("cancelled", () => reject(new Error("QR login cancelled")));
      this.once("timeout", () => reject(new Error("QR login expired")));
      this.once("error", reject);
    });
  }

  /** Отменить сессию (закрыть соединение). */
  cancel(): void {
    if (this.status === "approved" || this.status === "cancelled" || this.status === "expired") return;
    this.setStatus("cancelled");
    this.emit("cancelled", this.state());
    this.close();
  }

  state(): QrStateDTO {
    return {
      status: this.status,
      url: this.url,
      qrImage: null,
      fingerprint: this.fingerprint,
      expiresAt: this.expiresAt,
      user: this.user ? { ...this.user, avatarUrl: null } : null,
      token: this.status === "approved" ? this.token : null,
      error: this.error,
    };
  }

  private handle(
    payload: any,
    encodedPublicKey: string,
    ready: (url: string) => void,
    fail: (err: Error) => void,
    timeoutMs: number,
  ) {
    switch (payload.op) {
      case "hello": {
        const interval = Number(payload.heartbeat_interval ?? 41_250);
        this.heartbeatTimer = setInterval(() => this.send({ op: "heartbeat" }), interval);
        this.timeoutTimer = setTimeout(() => {
          this.setStatus("expired");
          this.emit("timeout", this.state());
          this.close();
        }, timeoutMs);
        this.send({ op: "init", encoded_public_key: encodedPublicKey });
        break;
      }
      case "nonce_proof": {
        const nonce = this.decrypt(payload.encrypted_nonce);
        const proof = createHash("sha256")
          .update(nonce)
          .digest("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        this.send({ op: "nonce_proof", proof });
        break;
      }
      case "pending_remote_init": {
        this.fingerprint = String(payload.fingerprint);
        this.url = QR_PREFIX + this.fingerprint;
        this.expiresAt = new Date(Date.now() + timeoutMs).toISOString();
        this.setStatus("waiting");
        this.emit("ready", this.state());
        ready(this.url);
        break;
      }
      case "pending_ticket": {
        const decrypted = this.decrypt(payload.encrypted_user_payload ?? payload.encrypted_user).toString("utf8");
        const [id = "", , , username = ""] = decrypted.split(":");
        this.user = { id, username };
        this.setStatus("scanned");
        this.emit("scanned", this.state());
        break;
      }
      case "pending_login": {
        this.setStatus("approved");
        void this.exchangeTicket(String(payload.ticket)).then(
          (token) => {
            this.token = token;
            this.emit("token", token);
            this.close();
          },
          (err: unknown) => fail(err instanceof Error ? err : new Error(String(err))),
        );
        break;
      }
      case "cancel": {
        this.setStatus("cancelled");
        this.emit("cancelled", this.state());
        this.close();
        break;
      }
      case "heartbeat_ack":
        break;
      default:
        break;
    }
  }

  /** POST /users/@me/remote-auth/login → encrypted_token → токен. */
  private async exchangeTicket(ticket: string): Promise<string> {
    const data = await this.rest.post<any>(
      "/users/@me/remote-auth/login",
      { ticket },
      {
        auth: false,
        retries: 0,
        headers: {
          Origin: "https://discord.com",
          Referer: "https://discord.com/channels/@me",
        },
      },
    );
    if (!data?.encrypted_token) throw new Error("Discord не вернул encrypted_token");
    return this.decrypt(data.encrypted_token).toString("utf8");
  }

  private decrypt(payload: string): Buffer {
    if (!this.privateKey) throw new Error("QR session has no private key");
    return privateDecrypt(
      {
        key: this.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(String(payload), "base64"),
    );
  }

  private send(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private setStatus(status: QrStatus) {
    this.status = status;
  }

  private fail(err: Error) {
    this.status = "error";
    this.error = err.message;
    this.emit("error", err);
    this.close();
  }

  private stopTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.heartbeatTimer = null;
    this.timeoutTimer = null;
  }

  private close() {
    this.stopTimers();
    if (this.ws && this.ws.readyState <= 1) this.ws.close();
    this.ws = null;
    this.emit("close");
  }
}
