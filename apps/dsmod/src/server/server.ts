import type { QrSession } from "../auth";
import { join } from "node:path";
import { DscClient } from "../client";
import { DiscordApiError, UnauthorizedError, toErrorPayload } from "../errors";
import type { EventFrame, VoiceConnectionDTO } from "../types";
import { ScreenCapture, type ScreenFrame, type ScreenStatus } from "./screen";
import { dispatch, type RouteContext } from "./routes";

export interface BridgeOptions {
  /** Готовый клиент (если не передан — создаётся и подхватывает сессию). */
  client?: DscClient;
  /** Только loopback. */
  host?: string;
  port?: number;
  /** Если задан — все /api/* запросы требуют заголовок `x-dsmod-key`. */
  key?: string | null;
  /** Открывать Gateway при старте (нужно для живых событий). */
  connectGateway?: boolean;
  /** Отдавать демо-UI на GET / (по умолчанию true, если найден examples/ui/index.html). */
  serveUi?: boolean;
}

export interface Bridge {
  url: string;
  port: number;
  client: DscClient;
  stop(): void;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-dsmod-key",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });
}

const frame = (t: string, d: unknown): EventFrame => ({ t, d, s: null, ts: new Date().toISOString() });

/**
 * Отдаём демо-интерфейс прямо с моста — удобно для отладки и Tauri-превью.
 * Ищем файл в нескольких местах, потому что у скомпилированного exe
 * `import.meta.dir` указывает на виртуальную ФС бандла, а не на папку с exe.
 */
async function demoUiHtml(): Promise<string | null> {
  const candidates = [
    process.env.DSMOD_UI_PATH,                                  // явный путь (env)
    join(import.meta.dir, "..", "..", "examples", "ui", "index.html"), // разработка: <repo>/examples/ui
    join(import.meta.dir, "examples", "ui", "index.html"),      // exe, собранный с --asset examples/ui
    join(process.execPath, "..", "examples", "ui", "index.html"), // рядом с бинарником
    join(process.cwd(), "examples", "ui", "index.html"),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) return await file.text();
    } catch {
      // пробуем следующий кандидат
    }
  }
  return null;
}

const API_INDEX = {
  name: "dsmod",
  description: "Локальный мост Discord-мода: HTTP JSON + WebSocket событий",
  docs: "docs/api.md",
  http: [
    "GET    /api/health",
    "GET    /api/state",
    "POST   /api/auth/login {email,password}",
    "POST   /api/auth/mfa {ticket,loginInstanceId,method,code}",
    "POST   /api/auth/sms {ticket}",
    "POST   /api/auth/token {token}",
    "POST   /api/auth/qr | GET /api/auth/qr | POST /api/auth/qr/cancel",
    "POST   /api/auth/logout",
    "GET    /api/me",
    "GET    /api/chats | GET /api/chats/{id}",
    "GET    /api/channels/{id}/messages?limit&before&after&around",
    "POST   /api/channels/{id}/messages {content,...}",
    "POST   /api/channels/{id}/typing",
    "GET    /api/channels/{id}/pins",
    "PATCH  /api/messages/{channelId}/{messageId} {content}",
    "DELETE /api/messages/{channelId}/{messageId}",
    "GET    /api/guilds | GET /api/guilds/{id} | GET /api/guilds/{id}/channels",
    "GET    /api/guilds/{id}/members?limit&after | GET /api/guilds/{id}/roles",
    "GET    /api/channels/{id}",
    "GET    /api/voice",
    "POST   /api/voice/join {channelId,guildId?,selfMute?,selfDeaf?}",
    "POST   /api/voice/leave | POST /api/voice/state {selfMute?,selfDeaf?}",
    "POST   /api/voice/speaking {speaking} | POST /api/voice/audio {pcm}",
    "POST   /api/voice/options {forwardAudio}",
    "GET    /api/voice/stream | POST /api/voice/stream/start {width?,height?,fps?,bitrateKbps?,source?} | POST /api/voice/stream/stop",
    "POST   /api/chats/{id}/call | DELETE /api/chats/{id}/call",
    "GET    /api/screen",
    "POST   /api/screen/start {fps?,width?} | POST /api/screen/stop",
  ],
  ws: "ws://<host>:<port>/events → {t, d, s, ts} на каждое событие Gateway",
};

/**
 * Локальный HTTP + WebSocket мост.
 *
 * UI (Tauri/webview/браузер) не ходит в Discord напрямую — только сюда:
 * никаких токенов во фронтенде, никаких CORS-проблем.
 *
 * ```ts
 * const bridge = await startBridge();   // http://127.0.0.1:8787
 * ```
 */
export async function startBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const host = options.host ?? process.env.DSMOD_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.DSMOD_PORT ?? 8787);
  const key = options.key ?? process.env.DSMOD_KEY ?? null;

  const client = options.client ?? new DscClient();
  if (!client.isAuthenticated) await client.restore();

  let qr: QrSession | null = null;
  const subscribers = new Set<{ send(data: string): unknown }>();
  const screen = new ScreenCapture();

  const broadcast = (evt: EventFrame) => {
    const payload = JSON.stringify(evt);
    for (const ws of subscribers) ws.send(payload);
  };

  const broadcastAuth = async () => {
    if (client.isAuthenticated && !client.me) {
      try {
        await client.loadMe();
      } catch {
        // сессия могла протухнуть — UI сам поймает 401
      }
    }
    broadcast(frame("DSMOD_AUTH", { authenticated: client.isAuthenticated, me: client.me }));
  };

  const ctx: RouteContext = {
    client,
    getQr: () => qr,
    setQr: (session) => {
      qr = session;
    },
    broadcast,
    broadcastAuth,
    screen,
  };

  // Gateway → все подключённые UI
  client.on("event", (evt: EventFrame) => broadcast(evt));
  client.on("status", (status: string) => broadcast(frame("DSMOD_GATEWAY", { status })));
  // Голос → все подключённые UI
  client.on("voice", (dto: VoiceConnectionDTO) => broadcast(frame("DSMOD_VOICE", dto)));
  client.on("voice-dave", (state: unknown) => broadcast(frame("DSMOD_VOICE_DAVE", state)));
  client.on("voice-speaking", (event: unknown) => broadcast(frame("DSMOD_VOICE_SPEAKING", event)));
  client.on("voice-audio", (event: { userId: string; pcm: Buffer }) =>
    broadcast(frame("DSMOD_VOICE_AUDIO", { userId: event.userId, pcm: event.pcm.toString("base64") })),
  );
  client.on("debug", (message: unknown) => broadcast(frame("DSMOD_DEBUG", { message: String(message) })));
  // Демонстрация экрана → все подключённые UI
  screen.on("status", (status: ScreenStatus) => broadcast(frame("DSMOD_SCREEN_STATUS", status)));
  screen.on("frame", (frame_: ScreenFrame) => broadcast(frame("DSMOD_SCREEN_FRAME", frame_)));

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/events") {
        const upgraded = srv.upgrade(req);
        if (upgraded) return undefined as unknown as Response;
        return json({ ok: false, error: { code: "upgrade_failed", message: "WebSocket required" } }, 426);
      }

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if ((url.pathname === "/" || url.pathname === "/ui") && options.serveUi !== false) {
        const html = await demoUiHtml();
        if (html !== null) {
          return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
        }
      }

      if (
        key &&
        url.pathname.startsWith("/api/") &&
        url.pathname !== "/api/health" &&
        req.headers.get("x-dsmod-key") !== key
      ) {
        return json({ ok: false, error: { code: "unauthorized", message: "Missing or invalid x-dsmod-key" } }, 401);
      }

      if (url.pathname === "/" || url.pathname === "/api") return json(API_INDEX);

      try {
        const parts = url.pathname.split("/").filter(Boolean);
        const data = await dispatch(ctx, req.method ?? "GET", parts, req, url.searchParams);
        return json({ ok: true, data });
      } catch (err) {
        const payload = toErrorPayload(err);
        const status =
          err instanceof UnauthorizedError
            ? 401
            : err instanceof DiscordApiError
              ? err.status
              : payload.code === "not_found"
                ? 404
                : payload.code === "invalid_body"
                  ? 400
                  : payload.code === "conflict" || payload.code === "not_in_voice"
                    ? 409
                    : payload.code === "gateway_required"
                      ? 503
                      : 500;
        return json({ ok: false, error: payload }, status);
      }
    },
    websocket: {
      open(ws) {
        subscribers.add(ws);
        ws.send(JSON.stringify(frame("DSMOD_HELLO", { version: 1 })));
      },
      message(ws, message) {
        if (String(message) === "ping") ws.send(JSON.stringify(frame("DSMOD_PONG", {})));
      },
      close(ws) {
        subscribers.delete(ws);
      },
    },
  });

  const actualPort = server.port ?? port;
  const url = `http://${host}:${actualPort}`;

  if (options.connectGateway !== false && client.isAuthenticated) {
    void client
      .connect()
      .then(() => broadcast(frame("DSMOD_GATEWAY", { status: client.gateway?.status ?? "ready" })))
      .catch((err: unknown) => broadcast(frame("DSMOD_GATEWAY", { status: "error", error: String(err) })));
  }

  return {
    url,
    port: actualPort,
    client,
    stop() {
      screen.stop();
      client.disconnect();
      server.stop(true);
    },
  };
}
