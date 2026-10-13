import { base64Json, type ResolvedOptions } from "../config";
import { DiscordApiError, RateLimitError } from "../errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Заголовок X-Audit-Log-Reason (нужен для некоторых endpoint'ов). */
  auditLogReason?: string;
  /** Отправлять ли Authorization (по умолчанию да, если есть токен). */
  auth?: boolean;
  /** Сколько раз повторять запрос при 429. */
  retries?: number;
}

interface RouteState {
  remaining: number;
  resetAt: number;
}

const snowflake = /\d{15,21}/g;

/** Ключ rate-limit bucket: метод + путь без конкретных id. */
function routeKey(method: HttpMethod, path: string): string {
  return `${method} ${path.split("?")[0]!.replace(snowflake, ":id")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Тонкая обёртка над Discord REST API (v9).
 *
 * - подставляет Authorization / User-Agent / X-Super-Properties;
 * - уважает rate-limits по заголовкам и по телу 429;
 * - бросает DiscordApiError с кодом Discord — UI может показать причину.
 *
 * Документация endpoint'ов: https://discord.com/developers/docs/resources/...
 */
export class DiscordRest {
  token: string | null;
  private readonly opts: ResolvedOptions;
  private readonly routes = new Map<string, RouteState>();

  constructor(opts: ResolvedOptions) {
    this.opts = opts;
    this.token = opts.token;
  }

  get apiBase() {
    return this.opts.apiBase;
  }

  setToken(token: string | null) {
    this.token = token;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  async post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  async patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  async put<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  async del<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.opts.apiBase + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    const key = routeKey(method, path);
    await this.waitForBucket(key);

    const headers: Record<string, string> = {
      Accept: "*/*",
      "Accept-Language": this.opts.locale,
      "User-Agent": this.opts.userAgent,
      "X-Discord-Locale": this.opts.locale,
      "X-Super-Properties": base64Json(this.opts.properties),
      ...options.headers,
    };
    const wantsAuth = options.auth !== false && Boolean(this.token);
    if (wantsAuth) headers.Authorization = this.token!;
    if (options.auditLogReason) headers["X-Audit-Log-Reason"] = encodeURIComponent(options.auditLogReason);

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, init);
    this.trackRateLimit(key, response);

    if (response.status === 429) {
      const retryAfter = await this.retryAfter(response);
      const attempts = options.retries ?? 3;
      if (attempts > 0) {
        await sleep(Math.ceil(retryAfter * 1000) + 25);
        return this.request<T>(method, path, { ...options, retries: attempts - 1 });
      }
      throw new RateLimitError(retryAfter, key);
    }

    const text = await response.text();
    const json = text ? safeJson(text) : null;

    if (!response.ok) {
      let message = `Discord API error ${response.status}`;
      if (json && typeof json === "object" && "message" in json) {
        const raw = (json as Record<string, unknown>).message;
        if (typeof raw === "string") message = raw;
        else if (Array.isArray(raw)) message = raw.map(String).join(", ");
      }
      const code = json && typeof json === "object" && "code" in json ? Number((json as any).code) : null;
      throw new DiscordApiError(response.status, Number.isFinite(code) ? code : null, message, json);
    }

    return (json ?? null) as T;
  }

  private async waitForBucket(key: string) {
    const state = this.routes.get(key);
    if (!state || state.remaining > 0 || state.resetAt <= Date.now()) return;
    await sleep(state.resetAt - Date.now() + 50);
  }

  private trackRateLimit(key: string, response: Response) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAfter = response.headers.get("x-ratelimit-reset-after");
    if (remaining === null && resetAfter === null) return;
    this.routes.set(key, {
      remaining: Number(remaining ?? 1),
      resetAt: Date.now() + Number(resetAfter ?? 0) * 1000,
    });
  }

  private async retryAfter(response: Response): Promise<number> {
    const header = Number(response.headers.get("retry-after"));
    if (Number.isFinite(header) && header > 0) return header;
    const body = safeJson(await response.text());
    const retryAfter = body && typeof body === "object" ? Number((body as any).retry_after) : NaN;
    return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
