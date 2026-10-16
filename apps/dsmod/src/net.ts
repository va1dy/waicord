/**
 * WebSocket с поддержкой HTTP-прокси из окружения.
 *
 * Bun-овый `fetch` сам читает `HTTPS_PROXY`, а `WebSocket` — нет:
 * прокси нужно передать явной опцией конструктора (Bun 1.4+).
 * Приоритет имён: DSMOD_PROXY → HTTPS_PROXY → ALL_PROXY → HTTP_PROXY
 * (и их lowercase-варианты) — так мост работает за прокси/Local-Proxy
 * клиентами вроде xray/Shade, не затрагивая остальные приложения.
 */

const PROXY_ENV_NAMES = [
  "DSMOD_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;

/** Прокси из окружения или null, если ничего не настроено. */
export function envProxy(): string | null {
  for (const name of PROXY_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** Опции конструктора WebSocket: headers и т.п. плюс proxy из окружения. */
export function wsInit(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const proxy = envProxy();
  return proxy ? { ...extra, proxy } : extra;
}
