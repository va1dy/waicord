import { EventEmitter } from "node:events";
import { Authenticator, type MfaCredentials, type PasswordCredentials, type QrOptions, QrSession } from "./auth";
import { resolveOptions, type DscOptions, type ResolvedOptions } from "./config";
import { UnauthorizedError } from "./errors";
import { GatewayClient, type GatewayOptions } from "./gateway";
import { DiscordRest } from "./http/client";
import { Resources } from "./resources";
import type { AuthResult, EventFrame, SessionDTO, UserDTO } from "./types";

export interface ClientEventMap {
  /** Любое gateway-событие (MESSAGE_CREATE, TYPING_START, …) */
  [event: string]: any;
  /** Сырой кадр события, удобно для проброса в UI */
  event: [frame: EventFrame];
  ready: [data: any];
  resumed: [];
  status: [status: string];
  error: [error: unknown];
  close: [info: { code: number }];
}

/**
 * Точка входа SDK.
 *
 * ```ts
 * const client = new DscClient();
 * await client.restore();                 // подхватить сохранённую сессию
 * await client.connect();                 // живые события
 * const chats = await client.api.chats(); // список чатов
 * await client.api.send(chats[0].id, "привет");
 * ```
 */
export class DscClient extends EventEmitter {
  readonly rest: DiscordRest;
  readonly auth: Authenticator;
  /** Все методы Discord API (чаты, сообщения, серверы, пользователи). */
  readonly api: Resources;
  readonly options: ResolvedOptions;

  /** Текущая сессия (после restore/login). */
  session: SessionDTO | null = null;
  /** Текущий пользователь — заполняется после loadMe(). */
  me: UserDTO | null = null;
  gateway: GatewayClient | null = null;

  constructor(options: DscOptions = {}) {
    super();
    this.options = resolveOptions(options);
    this.rest = new DiscordRest(this.options);
    this.auth = new Authenticator(this.rest, this.options.sessionPath);
    this.api = new Resources(this.rest);
    // слушатель по умолчанию: иначе EventEmitter бросает при 'error' без подписчиков
    this.on("error", () => undefined);
  }

  get token(): string | null {
    return this.rest.token;
  }

  get isAuthenticated(): boolean {
    return Boolean(this.rest.token);
  }

  /** Подхватывает сохранённую сессию (~/.dsmod/session.json или DSMOD_TOKEN). */
  async restore(): Promise<SessionDTO | null> {
    if (this.options.token) {
      this.session = { token: this.options.token, user: null, savedAt: new Date().toISOString() };
      this.rest.setToken(this.options.token);
      return this.session;
    }
    this.session = await this.auth.restore();
    return this.session;
  }

  /** Вход по паролю. При challenge (MFA/капча) — вернёт его UI, токена ещё нет. */
  async login(credentials: PasswordCredentials): Promise<AuthResult> {
    const result = await this.auth.login(credentials);
    this.session = result.ok ? { token: result.token, user: result.user, savedAt: new Date().toISOString() } : null;
    return result;
  }

  /** Ответ на MFA-челлендж из login(). */
  async solveMfa(
    challenge: { ticket: string; loginInstanceId?: string | null },
    credentials: Omit<MfaCredentials, "ticket" | "loginInstanceId">,
  ): Promise<AuthResult> {
    const result = await this.auth.solveMfa(challenge, credentials);
    this.session = result.ok ? { token: result.token, user: result.user, savedAt: new Date().toISOString() } : null;
    return result;
  }

  /** QR-вход: `const qr = client.startQr(); await qr.start();` → рисуем qr.url. */
  startQr(options?: QrOptions): QrSession {
    return this.auth.startQr(options);
  }

  /** Использовать готовый токен (например, вставленный в UI). */
  async useToken(token: string, user?: UserDTO | null): Promise<SessionDTO> {
    this.session = await this.auth.useToken(token, user);
    return this.session;
  }

  /** Выход: закрывает gateway и удаляет файл сессии. */
  async logout(): Promise<void> {
    this.disconnect();
    await this.auth.logout();
    this.session = null;
    this.me = null;
  }

  /** Загружает /users/@me (нужен авторизованный токен). */
  async loadMe(): Promise<UserDTO> {
    const me = await this.api.me();
    this.me = me;
    if (this.session) this.session = { ...this.session, user: me };
    return me;
  }

  /** Открывает Gateway; резолвится после READY. */
  async connect(extra: Partial<GatewayOptions> = {}): Promise<void> {
    const token = this.rest.token;
    if (!token) throw new UnauthorizedError("Нет токена — сначала login() или restore()");

    this.gateway?.disconnect();
    const gateway = new GatewayClient({
      token,
      apiVersion: this.options.apiVersion,
      userAgent: this.options.userAgent,
      properties: this.options.properties,
      locale: this.options.locale,
      bot: this.options.bot,
      ...extra,
    });
    this.gateway = gateway;

    const forward = (frame: EventFrame) => this.emit("event", frame);
    gateway.on("event", forward);
    for (const name of ["ready", "resumed", "status", "error", "close"] as const) {
      gateway.on(name, (...args: unknown[]) => this.emit(name, ...args));
    }

    await gateway.connect();
  }

  /** Закрывает Gateway (HTTP-мост продолжает работать). */
  disconnect(): void {
    this.gateway?.disconnect();
  }
}
