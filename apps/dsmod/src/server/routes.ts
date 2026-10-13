import type { DscClient } from "../client";
import type { QrSession } from "../auth";
import { DsmodError, UnauthorizedError } from "../errors";
import { qrDataUrl } from "../qr-image";
import type { ScreenCapture } from "./screen";
import type { EventFrame, QrStateDTO } from "../types";

/** QR отдаём картинкой — UI не подключает никаких qr-библиотек. */
const qrImages = new WeakMap<QrSession, string>();

const IDLE_QR: QrStateDTO = {
  status: "idle",
  url: null,
  qrImage: null,
  fingerprint: null,
  expiresAt: null,
  user: null,
  token: null,
  error: null,
};

function qrState(session: QrSession | null): QrStateDTO {
  if (!session) return IDLE_QR;
  const state: QrStateDTO = { ...session.state(), qrImage: qrImages.get(session) ?? null };
  // токен отдаём ровно один раз — дальше UI ориентируется на status === "approved"
  if (state.token) session.token = null;
  return state;
}

/** Общий контекст для всех HTTP-роутов моста. */
export interface RouteContext {
  client: DscClient;
  getQr(): QrSession | null;
  setQr(session: QrSession | null): void;
  broadcast(frame: EventFrame): void;
  /** Разослать изменение статуса входа всем UI. */
  broadcastAuth(): Promise<void>;
  /** Захват экрана (демонстрация экрана в UI). */
  screen: ScreenCapture;
}

type Body = Record<string, any>;

const now = () => new Date().toISOString();

function frame(t: string, d: unknown): EventFrame {
  return { t, d, s: null, ts: now() };
}

async function readBody(req: Request): Promise<Body> {
  try {
    const data = await req.json();
    return data && typeof data === "object" ? (data as Body) : {};
  } catch {
    return {};
  }
}

/**
 * Роутер локального моста. Возвращает данные — обёртку `{ok,data}`
 * делает сервер (см. server.ts). Бросает DsmodError при ошибке.
 *
 * Список endpoint'ов: docs/api.md
 */
export async function dispatch(
  ctx: RouteContext,
  method: string,
  parts: string[],
  req: Request,
  query: URLSearchParams,
): Promise<unknown> {
  const [root, a, b, c] = parts;
  if (root !== "api") throw new DsmodError("not_found", `Unknown path: /${parts.join("/")}`);

  // ---- health / state -------------------------------------------------
  if (a === "health") {
    const client = ctx.client;
    return {
      status: "ok",
      authenticated: client.isAuthenticated,
      gateway: client.gateway?.status ?? "idle",
      sessionId: client.gateway?.sessionId ?? null,
    };
  }

  if (a === "state") {
    const client = ctx.client;
    let me = client.me;
    if (client.isAuthenticated && !me) {
      try {
        me = await client.loadMe();
      } catch {
        me = null;
      }
    }
    const chats = client.isAuthenticated ? await client.api.chats() : [];
    return {
      me,
      chats,
      gateway: {
        connected: client.gateway?.status === "ready" || client.gateway?.status === "resumed",
        sessionId: client.gateway?.sessionId ?? null,
        eventsReceived: client.gateway?.eventsReceived ?? 0,
        lastEventAt: client.gateway?.lastEventAt ?? null,
        reconnects: client.gateway?.reconnects ?? 0,
      },
    };
  }

  // ---- auth -----------------------------------------------------------
  if (a === "auth") {
    if (b === "login" && method === "POST") {
      const body = await readBody(req);
      const result = await ctx.client.login({
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
      });
      if (result.ok) {
        await ctx.broadcastAuth();
        return { authenticated: true, me: await safeMe(ctx), challenge: null, error: null };
      }
      return { authenticated: false, me: null, challenge: result.challenge, error: result.error };
    }

    if (b === "mfa" && method === "POST") {
      const body = await readBody(req);
      const result = await ctx.client.solveMfa(
        { ticket: String(body.ticket ?? ""), loginInstanceId: body.loginInstanceId ?? null },
        { code: String(body.code ?? ""), method: body.method === "sms" ? "sms" : "totp" },
      );
      if (result.ok) {
        await ctx.broadcastAuth();
        return { authenticated: true, me: await safeMe(ctx), challenge: null, error: null };
      }
      return { authenticated: false, me: null, challenge: result.challenge, error: result.error };
    }

    if (b === "sms" && method === "POST") {
      const body = await readBody(req);
      const phone = await ctx.client.auth.sendMfaSms(String(body.ticket ?? ""));
      return { phone };
    }

    if (b === "token" && method === "POST") {
      const body = await readBody(req);
      const token = String(body.token ?? "").trim();
      if (!token) throw new DsmodError("invalid_body", "Field `token` is required");
      await ctx.client.useToken(token);
      await ctx.broadcastAuth();
      return { authenticated: true, me: await safeMe(ctx) };
    }

    if (b === "qr") {
      if (method === "POST") {
        ctx.getQr()?.cancel();
        const session = ctx.client.startQr();
        ctx.setQr(session);
        session.on("error", () => undefined);
        const broadcastState = () => ctx.broadcast(frame("DSMOD_QR", qrState(session)));
        session.on("ready", broadcastState);
        session.on("scanned", broadcastState);
        session.on("cancelled", broadcastState);
        session.on("timeout", broadcastState);
        session.on("token", async (token: string) => {
          await ctx.client.useToken(token);
          broadcastState();
          await ctx.broadcastAuth();
        });
        const url = await session.start();
        const qrImage = await qrDataUrl(url);
        if (qrImage) qrImages.set(session, qrImage);
        return { url, qrImage, state: qrState(session) };
      }
      if (method === "GET") return qrState(ctx.getQr());
      if (method === "POST" && c === "cancel") {
        ctx.getQr()?.cancel();
        return qrState(ctx.getQr());
      }
    }

    if (b === "logout" && method === "POST") {
      ctx.getQr()?.cancel();
      await ctx.client.logout();
      await ctx.broadcastAuth();
      return { authenticated: false };
    }

    throw new DsmodError("not_found", `Unknown route: ${method} /${parts.join("/")}`);
  }

  // ---- текущий пользователь ------------------------------------------
  if (a === "me" && method === "GET") {
    requireAuth(ctx);
    return ctx.client.loadMe();
  }

  // ---- чаты -----------------------------------------------------------
  if (a === "chats") {
    requireAuth(ctx);
    if (!b && method === "GET") return ctx.client.api.chats();
    if (b && method === "GET") return ctx.client.api.chat(b);
  }

  // ---- звонок в ЛС: POST начать / DELETE закончить ---------------------
  if (a === "chats" && b && c === "call") {
    requireAuth(ctx);
    if (method === "POST") return ctx.client.voice.join({ channelId: b, guildId: null });
    if (method === "DELETE") {
      if (ctx.client.voice.channelId !== b) {
        throw new DsmodError("conflict", "Звонок идёт в другом канале (см. GET /api/voice)");
      }
      return ctx.client.voice.leave();
    }
  }

  if (a === "channels" && b) {
    requireAuth(ctx);
    if (c === "messages") {
      if (method === "GET") {
        return ctx.client.api.messages(b, {
          limit: Number(query.get("limit") ?? 50) || 50,
          before: query.get("before") ?? undefined,
          after: query.get("after") ?? undefined,
          around: query.get("around") ?? undefined,
        });
      }
      if (method === "POST") {
        const body = await readBody(req);
        return ctx.client.api.send(b, body);
      }
    }
    if (c === "typing" && method === "POST") {
      await ctx.client.api.typing(b);
      return { ok: true };
    }
    if (c === "pins" && method === "GET") return ctx.client.api.pins(b);
    if (!c && method === "GET") return ctx.client.api.chat(b);
  }

  if (a === "messages" && b && c) {
    requireAuth(ctx);
    if (method === "PATCH") {
      const body = await readBody(req);
      return ctx.client.api.edit(b, c, { content: body.content, flags: body.flags });
    }
    if (method === "DELETE") {
      await ctx.client.api.remove(b, c);
      return { deleted: true };
    }
  }

  // ---- голос: звонки, голосовые каналы, аудио --------------------------
  if (a === "voice") {
    requireAuth(ctx);
    if (!b && method === "GET") return ctx.client.voice.status();
    if (b === "join" && method === "POST") {
      const body = await readBody(req);
      if (!body.channelId) throw new DsmodError("invalid_body", "Field `channelId` is required");
      return ctx.client.voice.join({
        channelId: String(body.channelId),
        guildId: body.guildId ? String(body.guildId) : null,
        selfMute: Boolean(body.selfMute),
        selfDeaf: Boolean(body.selfDeaf),
      });
    }
    if (b === "leave" && method === "POST") return ctx.client.voice.leave();
    if (b === "state" && method === "POST") {
      const body = await readBody(req);
      return ctx.client.voice.setState({
        selfMute: body.selfMute === undefined ? undefined : Boolean(body.selfMute),
        selfDeaf: body.selfDeaf === undefined ? undefined : Boolean(body.selfDeaf),
      });
    }
    if (b === "speaking" && method === "POST") {
      const body = await readBody(req);
      ctx.client.voice.setSpeaking(typeof body.speaking === "number" ? body.speaking : Boolean(body.speaking));
      return ctx.client.voice.status();
    }
    if (b === "audio" && method === "POST") {
      const body = await readBody(req);
      if (typeof body.pcm !== "string" || !body.pcm) {
        throw new DsmodError("invalid_body", "Field `pcm` (base64) is required");
      }
      const pcm = Buffer.from(body.pcm, "base64");
      if (pcm.length === 0 || pcm.length % 3840 !== 0) {
        throw new DsmodError("invalid_body", "`pcm` должен быть кратен 3840 байтам (20 мс: s16le, 48 кГц, стерео)");
      }
      return { sent: ctx.client.voice.sendPcm(pcm) };
    }
    if (b === "options" && method === "POST") {
      const body = await readBody(req);
      if (body.forwardAudio !== undefined) ctx.client.voice.setForwardAudio(Boolean(body.forwardAudio));
      return { forwardAudio: ctx.client.voice.audioForwarding };
    }
  }

  // ---- демонстрация экрана: локальный захват кадров --------------------
  if (a === "screen") {
    requireAuth(ctx);
    if (!b && method === "GET") return ctx.screen.status();
    if (b === "start" && method === "POST") {
      const body = await readBody(req);
      return ctx.screen.start({
        fps: body.fps === undefined ? undefined : Number(body.fps),
        width: body.width === undefined ? undefined : Number(body.width),
      });
    }
    if (b === "stop" && method === "POST") return ctx.screen.stop();
  }

  // ---- серверы --------------------------------------------------------
  if (a === "guilds") {
    requireAuth(ctx);
    if (!b && method === "GET") return ctx.client.api.guilds();
    if (b && c === "channels" && method === "GET") return ctx.client.api.guildChats(b);
    if (b && c === "members" && method === "GET") {
      return ctx.client.api.guildMembers(b, {
        limit: Number(query.get("limit") ?? 100) || 100,
        after: query.get("after") ?? undefined,
      });
    }
    if (b && c === "roles" && method === "GET") return ctx.client.api.guildRoles(b);
    if (b && !c && method === "GET") return ctx.client.api.guild(b);
  }

  throw new DsmodError("not_found", `Unknown route: ${method} /${parts.join("/")}`);
}

function requireAuth(ctx: RouteContext) {
  if (!ctx.client.isAuthenticated) throw new UnauthorizedError("Нужен вход: POST /api/auth/login | /api/auth/qr | /api/auth/token");
}

async function safeMe(ctx: RouteContext) {
  try {
    return await ctx.client.loadMe();
  } catch {
    return null;
  }
}
