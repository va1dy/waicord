/** Единое дерево ошибок API — UI может показать человеку понятное сообщение. */
export class DsmodError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Ошибка HTTP-слоя Discord (не-2xx ответ). */
export class DiscordApiError extends DsmodError {
  readonly status: number;
  /** Код ошибки из тела ответа Discord (например 50035 — невалидное поле) */
  readonly discordCode: number | null;
  readonly raw: unknown;

  constructor(status: number, discordCode: number | null, message: string, raw?: unknown) {
    super(`discord_${status}`, message, { status, discordCode, raw });
    this.status = status;
    this.discordCode = discordCode;
    this.raw = raw;
  }
}

/** Превышен лимит Discord даже после повторов. */
export class RateLimitError extends DiscordApiError {
  readonly retryAfter: number;

  constructor(retryAfter: number, route: string) {
    super(429, 0, `Rate limited on ${route}, retry_after=${retryAfter}s`, { route, retryAfter });
    this.retryAfter = retryAfter;
  }
}

/** Нужен дополнительный шаг входа (MFA/капча/верификация). */
export class AuthChallengeError extends DsmodError {
  readonly challenge: unknown;

  constructor(challenge: unknown, message = "Additional authentication step required") {
    super("auth_challenge", message, challenge);
    this.challenge = challenge;
  }
}

/** Токен отсутствует, истёк или отозван — UI должен показать экран входа. */
export class UnauthorizedError extends DsmodError {
  constructor(message = "Not authenticated") {
    super("unauthorized", message);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function toErrorPayload(err: unknown) {
  if (err instanceof DsmodError) return err.toJSON();
  return { code: "internal_error", message: errorMessage(err) };
}
