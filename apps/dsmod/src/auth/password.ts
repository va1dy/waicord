import type { DiscordRest } from "../http/client";
import { DiscordApiError } from "../errors";
import type { AuthChallenge, AuthResult } from "../types";

export interface PasswordCredentials {
  email: string;
  password: string;
}

export interface MfaCredentials {
  ticket: string;
  loginInstanceId?: string | null;
  code: string;
  method: "totp" | "sms";
}

const noAuth = { auth: false as const, retries: 0 };

function success(token: unknown): AuthResult | null {
  if (token && typeof token === "object" && typeof (token as any).token === "string") {
    return { ok: true, token: (token as any).token, user: null };
  }
  return null;
}

/** Разбирает ответ POST /auth/login на «вход прошёл» или «нужен ещё шаг». */
function parseLoginResponse(data: any): AuthResult {
  const direct = success(data);
  if (direct) return direct;

  if (data?.ticket) {
    const methods: Array<"totp" | "sms" | "webauthn"> = [];
    if (data.totp) methods.push("totp");
    if (data.sms) methods.push("sms");
    if (data.webauthn) methods.push("webauthn");
    if (methods.length > 0) {
      const challenge: AuthChallenge = {
        type: "mfa",
        methods,
        ticket: String(data.ticket),
        loginInstanceId: data.login_instance_id ? String(data.login_instance_id) : null,
        maskedEmail: data.email ?? null,
      };
      return { ok: false, challenge, error: { code: "mfa_required", message: "Two-factor code required" } };
    }
  }

  return {
    ok: false,
    challenge: null,
    error: {
      code: "unexpected_login_response",
      message: "Discord вернул неожиданный ответ на вход",
      details: data,
    },
  };
}

/** Коды ошибок Discord, которые означают конкретный шаг для UI. */
function mapLoginError(err: unknown): AuthResult {
  if (!(err instanceof DiscordApiError)) {
    return { ok: false, challenge: null, error: { code: "network_error", message: String((err as any)?.message ?? err) } };
  }

  const raw: any = err.raw;

  if (Array.isArray(raw?.captcha_key) || raw?.captcha_sitekey) {
    return {
      ok: false,
      challenge: {
        type: "captcha",
        captchaKey: raw.captcha_key?.[0] ?? null,
        captchaSitekey: raw.captcha_sitekey ?? null,
      },
      error: { code: "captcha_required", message: "Discord запросил капчу", details: raw },
    };
  }

  switch (err.discordCode) {
    case 50035:
      return {
        ok: false,
        challenge: null,
        error: { code: "invalid_credentials", message: "Неверная почта или пароль" },
      };
    case 40004: // rate limited
      return { ok: false, challenge: null, error: { code: "rate_limited", message: err.message } };
    case 20011:
    case 20013:
      return {
        ok: false,
        challenge: null,
        error: { code: "account_disabled", message: "Аккаунт заблокирован или помечен на удаление" },
      };
    case 70007:
      return {
        ok: false,
        challenge: { type: "phone", reason: "verification_required", message: "Discord требует подтвердить номер телефона" },
        error: { code: "phone_verification_required", message: "Требуется подтверждение номера телефона" },
      };
    case 70009:
      return {
        ok: false,
        challenge: {
          type: "email_code",
          reason: "verification_required",
          message: "Discord требует код с почты — открой письмо и введи код",
        },
        error: { code: "email_verification_required", message: "Требуется код с почты" },
      };
    default:
      if (err.status === 401) {
        return {
          ok: false,
          challenge: null,
          error: { code: "invalid_credentials", message: "Неверная почта или пароль" },
        };
      }
      return { ok: false, challenge: null, error: { code: `discord_${err.status}`, message: err.message, details: raw } };
  }
}

/**
 * Вход по почте и паролю — POST /auth/login.
 * Ответ: либо токен, либо challenge (MFA / капча / верификация).
 * Ничего не сохраняет — сохранением занимается Authenticator.
 */
export async function loginWithPassword(rest: DiscordRest, credentials: PasswordCredentials): Promise<AuthResult> {
  try {
    const data = await rest.post<any>(
      "/auth/login",
      { login: credentials.email, password: credentials.password },
      noAuth,
    );
    return parseLoginResponse(data);
  } catch (err) {
    return mapLoginError(err);
  }
}

/**
 * Ответ на MFA-вызов — POST /auth/mfa/{totp|sms}.
 * Успешный ответ содержит токен.
 */
export async function solveMfa(rest: DiscordRest, credentials: MfaCredentials): Promise<AuthResult> {
  const body: Record<string, unknown> = { code: credentials.code, ticket: credentials.ticket };
  if (credentials.loginInstanceId) body.login_instance_id = credentials.loginInstanceId;
  try {
    const data = await rest.post<any>(`/auth/mfa/${credentials.method}`, body, noAuth);
    const direct = success(data);
    if (direct) return direct;
    return {
      ok: false,
      challenge: null,
      error: { code: "mfa_failed", message: "Discord не принял код", details: data },
    };
  } catch (err) {
    if (err instanceof DiscordApiError) {
      if (err.discordCode === 50035 || err.status === 401) {
        return { ok: false, challenge: null, error: { code: "invalid_code", message: "Неверный код" } };
      }
      if (Array.isArray((err.raw as any)?.captcha_key)) {
        return { ok: false, challenge: null, error: { code: "captcha_required", message: err.message, details: err.raw } };
      }
    }
    return mapLoginError(err);
  }
}

/** Запросить SMS-код для MFA — POST /auth/mfa/sms/send. Возвращает маскированный номер. */
export async function sendMfaSms(rest: DiscordRest, ticket: string): Promise<string | null> {
  try {
    const data = await rest.post<any>("/auth/mfa/sms/send", { ticket }, noAuth);
    return data?.phone ?? null;
  } catch {
    return null;
  }
}

/** Подтвердить номер телефона (шаг 70007) — POST /phone-verifications/verify. */
export async function verifyPhone(rest: DiscordRest, phone: string, code: string): Promise<string | null> {
  const data = await rest.post<any>("/phone-verifications/verify", { phone, code }, noAuth);
  return data?.token ?? null;
}

/** Разрешить IP по токену из письма/SMS — POST /phone-verifications/verify. */
export async function authorizeIp(rest: DiscordRest, token: string): Promise<void> {
  await rest.post("/phone-verifications/verify", { token }, noAuth);
}
