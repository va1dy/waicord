import type { DscClient } from "../client";
import type { QrSession } from "../auth";
import { DsmodError, UnauthorizedError } from "../errors";
import { qrDataUrl } from "../qr-image";
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

  // ---- серверы --------------------------------------------------------
  if (a === "guilds") {
    requireAuth(ctx);
    if (!b && method === "GET") return ctx.client.api.guilds();
    if (b && c === "channels" && method === "GET") return ctx.client.api.guildChats(b);
    if (b && method === "GET") return ctx.client.api.guild(b);
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
