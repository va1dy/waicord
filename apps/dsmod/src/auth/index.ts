import type { DiscordRest } from "../http/client";
import type { AuthResult, SessionDTO, UserDTO } from "../types";
import { QrSession, type QrOptions } from "./qr";
import { loginWithPassword, sendMfaSms, solveMfa, type MfaCredentials, type PasswordCredentials } from "./password";
import { clearSession, loadSession, saveSession } from "./session";

export * from "./password";
export * from "./qr";
export * from "./session";

/**
 * Вход в аккаунт и хранение сессии.
 *
 * Три способа:
 *  - login({ email, password }) → токен или challenge (MFA/капча/верификация);
 *  - solveMfa(challenge, { code }) → токен;
 *  - startQr() → QR-код, после сканирования и подтверждения на телефоне → токен.
 *
 * Успешный токен сразу сохраняется в sessionPath.
 */
export class Authenticator {
  constructor(
    private readonly rest: DiscordRest,
    private readonly sessionPath: string,
  ) {}

  /** Загружает ранее сохранённую сессию. */
  async restore(): Promise<SessionDTO | null> {
    const session = await loadSession(this.sessionPath);
    if (session) this.rest.setToken(session.token);
    return session;
  }

  /** Вход по почте и паролю. Ничего не сохраняет, пока не пришёл токен. */
  async login(credentials: PasswordCredentials): Promise<AuthResult> {
    const result = await loginWithPassword(this.rest, credentials);
    return this.persist(result);
  }

  /** Ответ на MFA-челлендж из login(). */
  async solveMfa(challenge: { ticket: string; loginInstanceId?: string | null }, credentials: Omit<MfaCredentials, "ticket" | "loginInstanceId">): Promise<AuthResult> {
    const payload: MfaCredentials = {
      ticket: challenge.ticket,
      loginInstanceId: challenge.loginInstanceId ?? null,
      code: credentials.code,
      method: credentials.method,
    };
    const result = await solveMfa(this.rest, payload);
    return this.persist(result);
  }

  /** SMS-код для MFA. */
  async sendMfaSms(ticket: string): Promise<string | null> {
    return sendMfaSms(this.rest, ticket);
  }

  /** QR-сессия. `await session.start()` → рисуем `session.url`, ждём `waitForToken()`. */
  startQr(options?: QrOptions): QrSession {
    return new QrSession(this.rest, options);
  }

  /** Устанавливает токен вручную (например, из .env или из UI). */
  async useToken(token: string, user?: UserDTO | null): Promise<SessionDTO> {
    this.rest.setToken(token);
    return saveSession(this.sessionPath, token, user ?? null);
  }

  /** Выход: чистит токен в памяти и удаляет файл сессии. */
  async logout(): Promise<void> {
    this.rest.setToken(null);
    await clearSession(this.sessionPath);
  }

  private async persist(result: AuthResult): Promise<AuthResult> {
    if (!result.ok) return result;
    this.rest.setToken(result.token);
    const session = await saveSession(this.sessionPath, result.token, result.user);
    return { ...result, user: session.user };
  }
}
