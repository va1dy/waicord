import { homedir } from "node:os";
import { join } from "node:path";

/** Текущая версия API Discord, которую используем для REST и Gateway (как у официального клиента). */
export const API_VERSION = 9;

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.156 Chrome/131.0.0.0 Safari/537.36";

export interface DscOptions {
  /** User-токен (не "Bot ..."). Можно взять из DSMOD_TOKEN или из сессии. */
  token?: string | null;
  /** Базовый URL Discord API. */
  apiBase?: string;
  /** Версия API для REST и Gateway. */
  apiVersion?: number;
  /** User-Agent — должен выглядеть как настоящий клиент Discord. */
  userAgent?: string;
  /** Кастомные свойства клиента (попадают в X-Super-Properties). */
  properties?: Record<string, unknown>;
  /** Язык клиента (X-Discord-Locale). */
  locale?: string;
  /** Где хранить сессию. По умолчанию ~/.dsmod/session.json */
  sessionPath?: string;
  /** true, если токен бота ("Bot ...") — меняет формат Identify в Gateway. */
  bot?: boolean;
}

export interface ResolvedOptions extends Required<Omit<DscOptions, "properties" | "token">> {
  token: string | null;
  properties: Record<string, unknown>;
}

function osName(): string {
  const p = process.platform;
  if (p === "win32") return "Windows";
  if (p === "darwin") return "Mac OS X";
  return "Linux";
}

function osVersion(): string {
  if (process.arch === "arm64") return "arm64";
  return "10.0.19045";
}

/** Свойства клиента, которые Discord ждёт в X-Super-Properties и в Identify. */
export function defaultProperties(locale: string): Record<string, unknown> {
  return {
    os: osName(),
    browser: "Discord Client",
    device: "",
    system_locale: locale,
    browser_user_agent: DEFAULT_USER_AGENT,
    browser_version: "",
    os_version: osVersion(),
    os_arch: process.arch,
    referrer: "",
    referring_domain: "",
    referrer_current: "",
    referring_domain_current: "",
    release_channel: "stable",
    client_version: "1.0.156",
    client_event_source: null,
    launch_signature: Math.floor(Math.random() * 2 ** 32),
    client_build_number: 607562,
    has_client_mods: false,
  };
}

export function resolveOptions(options: DscOptions = {}): ResolvedOptions {
  const locale = options.locale ?? process.env.DSMOD_LOCALE ?? "en-US";
  const token = options.token ?? process.env.DSMOD_TOKEN ?? null;
  return {
    token: token && !token.startsWith("Bot ") ? token : token,
    apiBase: options.apiBase ?? `https://discord.com/api/v${options.apiVersion ?? API_VERSION}`,
    apiVersion: options.apiVersion ?? API_VERSION,
    userAgent: options.userAgent ?? process.env.DSMOD_USER_AGENT ?? DEFAULT_USER_AGENT,
    properties: { ...defaultProperties(locale), ...(options.properties ?? {}) },
    locale,
    sessionPath:
      options.sessionPath ??
      process.env.DSMOD_SESSION_PATH ??
      join(process.env.DSMOD_HOME ?? join(homedir(), ".dsmod"), "session.json"),
    bot: options.bot ?? Boolean(token?.startsWith("Bot ")),
  };
}

export function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "ascii").toString("base64");
}
