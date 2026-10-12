import { Database } from "bun:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "data.db");

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at)");

const general = db.query(`SELECT id FROM channels WHERE name = 'general'`).get() as { id: string } | null;
if (!general) {
  db.run(`INSERT INTO channels (id, name, created_at) VALUES (?, 'general', ?)`, [uid(), Date.now()]);
}

function uid(): string {
  return randomBytes(12).toString("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  created_at: number;
}

function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, email: u.email, created_at: u.created_at };
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function authUser(req: Request): UserRow | null {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const row = db
    .query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token) as UserRow | undefined;
  return row ?? null;
}

function createSession(userId: string): string {
  const token = randomBytes(24).toString("hex");
  db.run(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`, [token, userId, Date.now()]);
  return token;
}

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ChannelRow {
  id: string;
  name: string;
  created_at: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: number;
  username: string;
}

function messageView(m: MessageRow) {
  return {
    id: m.id,
    channel_id: m.channel_id,
    content: m.content,
    created_at: m.created_at,
    user: { id: m.user_id, username: m.username },
  };
}

let server: ReturnType<typeof Bun.serve>;

server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/ws") {
      const ok = srv.upgrade(req, { data: { token: url.searchParams.get("token") } });
      if (!ok) return json({ error: "WebSocket upgrade failed" }, 400);
      return undefined as unknown as Response;
    }

    const { pathname } = url;

    if (pathname === "/api/health" && req.method === "GET") {
      return json({ ok: true, name: "waicord", version: "0.1.0" });
    }

    if (pathname === "/api/register" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        username?: string;
        email?: string;
        password?: string;
      } | null;
      const username = body?.username?.trim() ?? "";
      const email = body?.email?.trim().toLowerCase() ?? "";
      const password = body?.password ?? "";
      if (!USERNAME_RE.test(username)) return json({ error: "Логин: 3–32 символа, буквы/цифры/_.-" }, 400);
      if (!EMAIL_RE.test(email)) return json({ error: "Некорректный email" }, 400);
      if (password.length < 8) return json({ error: "Пароль минимум 8 символов" }, 400);

      const exists = db
        .query(`SELECT id FROM users WHERE username = ? OR email = ?`)
        .get(username, email) as { id: string } | undefined;
      if (exists) return json({ error: "Логин или email уже заняты" }, 409);

      const user: UserRow = {
        id: uid(),
        username,
        email,
        password_hash: hashPassword(password),
        created_at: Date.now(),
      };
      db.run(
        `INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
        [user.id, user.username, user.email, user.password_hash, user.created_at]
      );
      return json({ token: createSession(user.id), user: publicUser(user) }, 201);
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        identifier?: string;
        password?: string;
      } | null;
      const identifier = body?.identifier?.trim() ?? "";
      const password = body?.password ?? "";
      if (!identifier || !password) return json({ error: "Введите логин/email и пароль" }, 400);

      const user = db
        .query(`SELECT * FROM users WHERE username = ? OR email = ?`)
        .get(identifier, identifier.toLowerCase()) as UserRow | undefined;
      if (!user || !verifyPassword(password, user.password_hash)) {
        return json({ error: "Неверный логин или пароль" }, 401);
      }
      return json({ token: createSession(user.id), user: publicUser(user) });
    }

    if (pathname === "/api/me" && req.method === "GET") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      return json({ user: publicUser(user) });
    }

    if (pathname === "/api/channels" && req.method === "GET") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const channels = db.query(`SELECT * FROM channels ORDER BY name`).all() as ChannelRow[];
      return json({ channels });
    }

    if (pathname === "/api/channels" && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const body = (await req.json().catch(() => null)) as { name?: string } | null;
      const name = body?.name?.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 32) ?? "";
      if (name.length < 2) return json({ error: "Имя канала: минимум 2 символа" }, 400);
      const exists = db.query(`SELECT id FROM channels WHERE name = ?`).get(name) as { id: string } | undefined;
      if (exists) return json({ error: "Канал уже существует" }, 409);
      const channel: ChannelRow = { id: uid(), name, created_at: Date.now() };
      db.run(`INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)`, [
        channel.id,
        channel.name,
        channel.created_at,
      ]);
      return json({ channel }, 201);
    }

    const channelMessages = pathname.match(/^\/api\/channels\/([a-f0-9]+)\/messages$/);
    if (channelMessages && req.method === "GET") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const channelId = channelMessages[1];
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
      const messages = db
        .query(
          `SELECT m.*, u.username FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(channelId, limit) as MessageRow[];
      return json({ messages: messages.reverse().map(messageView) });
    }

    if (channelMessages && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const channelId = channelMessages[1];
      const channel = db.query(`SELECT id FROM channels WHERE id = ?`).get(channelId) as
        | { id: string }
        | undefined;
      if (!channel) return json({ error: "Канал не найден" }, 404);
      const body = (await req.json().catch(() => null)) as { content?: string } | null;
      const content = body?.content?.trim() ?? "";
      if (!content) return json({ error: "Пустое сообщение" }, 400);
      if (content.length > 2000) return json({ error: "Максимум 2000 символов" }, 400);

      const message: MessageRow = {
        id: uid(),
        channel_id: channelId,
        user_id: user.id,
        content,
        created_at: Date.now(),
        username: user.username,
      };
      db.run(
        `INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
        [message.id, message.channel_id, message.user_id, message.content, message.created_at]
      );
      const view = messageView(message);
      server.publish("chat", JSON.stringify({ type: "message", message: view }));
      return json({ message: view }, 201);
    }

    return json({ error: "Не найдено" }, 404);
  },
  websocket: {
    open(ws) {
      const token = (ws.data as { token: string | null }).token;
      const user = token
        ? (db
            .query(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`)
            .get(token) as UserRow | undefined)
        : undefined;
      if (!user) {
        ws.close(4001, "unauthorized");
        return;
      }
      (ws.data as { userId?: string }).userId = user.id;
      ws.subscribe("chat");
    },
    message(ws, raw) {
      const userId = (ws.data as { userId?: string }).userId;
      if (!userId) return;
      let parsed: { type?: string; channel_id?: string; content?: string };
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (parsed.type !== "message" || !parsed.channel_id || !parsed.content) return;
      const content = parsed.content.trim().slice(0, 2000);
      if (!content) return;
      const channel = db.query(`SELECT id FROM channels WHERE id = ?`).get(parsed.channel_id) as
        | { id: string }
        | undefined;
      if (!channel) return;
      const user = db.query(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;
      const message: MessageRow = {
        id: uid(),
        channel_id: channel.id,
        user_id: user.id,
        content,
        created_at: Date.now(),
        username: user.username,
      };
      db.run(
        `INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
        [message.id, message.channel_id, message.user_id, message.content, message.created_at]
      );
      server.publish("chat", JSON.stringify({ type: "message", message: messageView(message) }));
    },
  },
});

console.log(`waicord server → http://0.0.0.0:${server.port} (db: ${DB_PATH})`);
