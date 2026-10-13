import { Database } from "bun:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "data.db");
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(import.meta.dir, "data", "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
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
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at)`);
db.run(`
  CREATE TABLE IF NOT EXISTS friends (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
    created_at INTEGER NOT NULL,
    UNIQUE (requester_id, addressee_id)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dm','group')),
    dm_key TEXT UNIQUE,
    name TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, user_id)
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(conversation_id, created_at)`);

function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn("users", "display_name", "TEXT");
ensureColumn("users", "status", "TEXT");
ensureColumn("users", "bio", "TEXT");
ensureColumn("users", "avatar_url", "TEXT");
ensureColumn("messages", "attachments", "TEXT");
ensureColumn("dm_messages", "attachments", "TEXT");
db.run(`
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    mime TEXT,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

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
  display_name: string | null;
  status: string | null;
  bio: string | null;
  avatar_url: string | null;
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    created_at: u.created_at,
    display_name: u.display_name,
    status: u.status,
    bio: u.bio,
    avatar_url: u.avatar_url,
  };
}

function userBrief(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    status: u.status,
  };
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
    .query(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`)
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

const online = new Map<string, number>();

function isOnline(userId: string): boolean {
  return (online.get(userId) ?? 0) > 0;
}

type AttachmentItem = string | { url: string; name?: string };

function normalizeAttachments(raw: unknown): AttachmentItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is AttachmentItem => {
      if (typeof a === "string") return a.length > 0;
      return !!a && typeof a === "object" && typeof (a as { url?: unknown }).url === "string";
    })
    .slice(0, 8);
}

function friendIds(userId: string): string[] {
  const rows = db
    .query(
      `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS fid
       FROM friends WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`
    )
    .all(userId, userId, userId) as { fid: string }[];
  return rows.map((r) => r.fid);
}

function publishToUser(userId: string, payload: unknown) {
  server.publish(`user:${userId}`, JSON.stringify(payload));
}

function notifyPresence(userId: string, onlineNow: boolean) {
  for (const fid of friendIds(userId)) {
    publishToUser(fid, { type: "presence", user_id: userId, online: onlineNow });
  }
}

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
  attachments: string | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

function parseAttachments(raw: string | null | undefined): AttachmentItem[] {
  if (!raw) return [];
  try {
    return normalizeAttachments(JSON.parse(raw));
  } catch {
    return [];
  }
}

function messageView(m: MessageRow) {
  return {
    id: m.id,
    channel_id: m.channel_id,
    content: m.content,
    created_at: m.created_at,
    attachments: parseAttachments(m.attachments),
    user: { id: m.user_id, username: m.username, display_name: m.display_name, avatar_url: m.avatar_url },
  };
}

interface DmMessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  content: string;
  created_at: number;
  attachments: string | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

function dmMessageView(m: DmMessageRow) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    content: m.content,
    created_at: m.created_at,
    attachments: parseAttachments(m.attachments),
    user: { id: m.user_id, username: m.username, display_name: m.display_name, avatar_url: m.avatar_url },
  };
}

function isMember(conversationId: string, userId: string): boolean {
  const row = db
    .query(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`)
    .get(conversationId, userId);
  return !!row;
}

function conversationMembers(conversationId: string) {
  return (
    db
      .query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status FROM conversation_members m JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = ? ORDER BY u.username`
      )
      .all(conversationId) as {
      id: string;
      username: string;
      display_name: string | null;
      avatar_url: string | null;
      status: string | null;
    }[]
  ).map((m) => ({ ...m, online: isOnline(m.id) }));
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

    if (pathname === "/api/me" && req.method === "PATCH") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const body = (await req.json().catch(() => null)) as {
        display_name?: string;
        status?: string;
        bio?: string;
        avatar_url?: string;
      } | null;
      if (!body) return json({ error: "Пустой запрос" }, 400);

      const display = body.display_name !== undefined ? body.display_name.trim().slice(0, 32) : user.display_name;
      const status = body.status !== undefined ? body.status.trim().slice(0, 64) : user.status;
      const bio = body.bio !== undefined ? body.bio.trim().slice(0, 190) : user.bio;
      let avatar = user.avatar_url;
      if (body.avatar_url !== undefined) {
        const a = body.avatar_url;
        if (a === null || a === "") avatar = null;
        else if (a.startsWith("data:image/") && a.length <= 400_000) avatar = a;
        else return json({ error: "Аватар: data-url изображения до 300КБ" }, 400);
      }

      db.run(`UPDATE users SET display_name = ?, status = ?, bio = ?, avatar_url = ? WHERE id = ?`, [
        display || null,
        status || null,
        bio || null,
        avatar,
        user.id,
      ]);
      const updated = db.query(`SELECT * FROM users WHERE id = ?`).get(user.id) as UserRow;
      publishToUser(user.id, { type: "profile_updated", user: publicUser(updated) });
      return json({ user: publicUser(updated) });
    }

    if (pathname === "/api/upload" && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const body = (await req.json().catch(() => null)) as { name?: string; data?: string } | null;
      const name = (body?.name ?? "file").replace(/[^\w.а-яё -]/gi, "_").slice(0, 100);
      const data = body?.data ?? "";
      if (!data) return json({ error: "Пустой файл" }, 400);
      const buffer = Buffer.from(data, "base64");
      if (buffer.length > 10 * 1024 * 1024) return json({ error: "Файл больше 10 МБ" }, 400);
      const id = uid();
      const ext = (extname(name) || "").toLowerCase().slice(0, 10);
      const stored = `${id}${ext}`;
      writeFileSync(join(UPLOAD_DIR, stored), buffer);
      db.run(`INSERT INTO uploads (id, user_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
        id,
        user.id,
        name,
        "",
        buffer.length,
        Date.now(),
      ]);
      return json({ url: `/uploads/${stored}`, name, size: buffer.length }, 201);
    }

    const uploadFile = pathname.match(/^\/uploads\/([a-zA-Z0-9._-]+)$/);
    if (uploadFile && req.method === "GET") {
      const stored = uploadFile[1];
      if (stored.includes("..")) return json({ error: "Плохой путь" }, 400);
      const path = join(UPLOAD_DIR, stored);
      if (!existsSync(path)) return json({ error: "Файл не найден" }, 404);
      const bytes = readFileSync(path);
      const ext = extname(stored).toLowerCase();
      const row = db.query(`SELECT name FROM uploads WHERE id = ?`).get(stored.replace(/\.[^.]+$/, "")) as
        | { name: string }
        | undefined;
      const filename = row?.name ?? stored;
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".gif"
            ? "image/gif"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".jpg" || ext === ".jpeg"
                ? "image/jpeg"
                : ext === ".mp4"
                  ? "video/mp4"
                  : ext === ".webm"
                    ? "video/webm"
                    : "application/octet-stream";
      const asciiName = filename.replace(/[^\x20-\x7e]/g, "_");
      return new Response(bytes, {
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400",
        },
      });
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
      server.publish("chat", JSON.stringify({ type: "channel_create", channel }));
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
          `SELECT m.*, u.username, u.display_name, u.avatar_url FROM messages m JOIN users u ON u.id = m.user_id
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
      const body = (await req.json().catch(() => null)) as { content?: string; attachments?: string[] } | null;
      const content = body?.content?.trim() ?? "";
      const attachments = normalizeAttachments(body?.attachments);
      if (!content && attachments.length === 0) return json({ error: "Пустое сообщение" }, 400);
      if (content.length > 2000) return json({ error: "Максимум 2000 символов" }, 400);

      const message: MessageRow = {
        id: uid(),
        channel_id: channelId,
        user_id: user.id,
        content,
        created_at: Date.now(),
        attachments: JSON.stringify(attachments),
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      };
      db.run(
        `INSERT INTO messages (id, channel_id, user_id, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)`,
        [message.id, message.channel_id, message.user_id, message.content, message.created_at, message.attachments]
      );
      server.publish("chat", JSON.stringify({ type: "message", message: messageView(message) }));
      return json({ message: messageView(message) }, 201);
    }

    if (pathname === "/api/friends" && req.method === "GET") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);

      const friendRows = db
        .query(
          `SELECT f.id AS request_id, u.id, u.username, u.display_name, u.avatar_url,
                  CASE WHEN f.requester_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction
           FROM friends f
           JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
           WHERE f.status = 'pending' AND (f.requester_id = ? OR f.addressee_id = ?)`
        )
        .all(user.id, user.id, user.id, user.id) as {
        request_id: string;
        id: string;
        username: string;
        display_name: string | null;
        avatar_url: string | null;
        direction: string;
      }[];

      const accepted = db
        .query(
          `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status FROM friends f
           JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
           WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
           ORDER BY u.username`
        )
        .all(user.id, user.id, user.id) as {
        id: string;
        username: string;
        display_name: string | null;
        avatar_url: string | null;
        status: string | null;
      }[];

      return json({
        friends: accepted.map((f) => ({ ...f, online: isOnline(f.id) })),
        incoming: friendRows.filter((r) => r.direction === "incoming"),
        outgoing: friendRows.filter((r) => r.direction === "outgoing"),
      });
    }

    if (pathname === "/api/friends/requests" && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const body = (await req.json().catch(() => null)) as { username?: string } | null;
      const username = body?.username?.trim() ?? "";
      if (!username) return json({ error: "Укажи логин" }, 400);

      const target = db.query(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
      if (!target) return json({ error: "Пользователь не найден" }, 404);
      if (target.id === user.id) return json({ error: "Нельзя добавить себя" }, 400);

      const existing = db
        .query(
          `SELECT * FROM friends
           WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`
        )
        .get(user.id, target.id, target.id, user.id) as
        | { id: string; requester_id: string; addressee_id: string; status: string }
        | undefined;

      if (existing) {
        if (existing.status === "accepted") return json({ error: "Вы уже друзья" }, 409);
        if (existing.requester_id === user.id) return json({ error: "Заявка уже отправлена" }, 409);
        db.run(`UPDATE friends SET status = 'accepted' WHERE id = ?`, [existing.id]);
        publishToUser(target.id, { type: "friend_accept", from: userBrief(user) });
        return json({ ok: true, accepted: true });
      }

      const id = uid();
      db.run(
        `INSERT INTO friends (id, requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
        [id, user.id, target.id, Date.now()]
      );
      publishToUser(target.id, { type: "friend_request", from: userBrief(user) });
      return json({ ok: true, request_id: id }, 201);
    }

    const friendAccept = pathname.match(/^\/api\/friends\/requests\/([a-f0-9]+)\/accept$/);
    if (friendAccept && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const row = db.query(`SELECT * FROM friends WHERE id = ?`).get(friendAccept[1]) as
        | { id: string; requester_id: string; addressee_id: string; status: string }
        | undefined;
      if (!row || row.addressee_id !== user.id) return json({ error: "Заявка не найдена" }, 404);
      if (row.status !== "pending") return json({ error: "Заявка уже обработана" }, 409);
      db.run(`UPDATE friends SET status = 'accepted' WHERE id = ?`, [row.id]);
      publishToUser(row.requester_id, { type: "friend_accept", from: userBrief(user) });
      return json({ ok: true });
    }

    const friendDecline = pathname.match(/^\/api\/friends\/requests\/([a-f0-9]+)\/decline$/);
    if (friendDecline && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const row = db.query(`SELECT * FROM friends WHERE id = ?`).get(friendDecline[1]) as
        | { id: string; requester_id: string; addressee_id: string }
        | undefined;
      if (!row || (row.addressee_id !== user.id && row.requester_id !== user.id))
        return json({ error: "Заявка не найдена" }, 404);
      db.run(`DELETE FROM friends WHERE id = ?`, [row.id]);
      return json({ ok: true });
    }

    const friendRemove = pathname.match(/^\/api\/friends\/([a-f0-9]+)$/);
    if (friendRemove && req.method === "DELETE") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      db.run(
        `DELETE FROM friends WHERE status = 'accepted' AND
         ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
        [user.id, friendRemove[1], friendRemove[1], user.id]
      );
      publishToUser(friendRemove[1], { type: "friend_remove", from: userBrief(user) });
      return json({ ok: true });
    }

    if (pathname === "/api/dms" && req.method === "GET") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const convs = db
        .query(
          `SELECT c.id, c.kind, c.name FROM conversations c
           JOIN conversation_members m ON m.conversation_id = c.id
           WHERE m.user_id = ? ORDER BY c.created_at DESC`
        )
        .all(user.id) as { id: string; kind: string; name: string | null }[];

      const view = convs.map((c) => {
        const last = db
          .query(
            `SELECT d.content, d.created_at, u.username FROM dm_messages d JOIN users u ON u.id = d.user_id
             WHERE d.conversation_id = ? ORDER BY d.created_at DESC LIMIT 1`
          )
          .get(c.id) as { content: string; created_at: number; username: string } | undefined;
        return {
          id: c.id,
          kind: c.kind,
          name: c.name,
          members: conversationMembers(c.id),
          last: last ? { content: last.content, created_at: last.created_at, username: last.username } : null,
        };
      });
      return json({ conversations: view });
    }

    if (pathname === "/api/dms" && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const body = (await req.json().catch(() => null)) as {
        usernames?: string[];
        name?: string;
        kind?: "dm" | "group";
      } | null;
      const usernames = (body?.usernames ?? []).map((u) => u.trim()).filter(Boolean);
      if (usernames.length < 1) return json({ error: "Выбери хотя бы одного друга" }, 400);

      const targets: UserRow[] = [];
      for (const username of usernames) {
        const target = db.query(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
        if (!target) return json({ error: `Пользователь ${username} не найден` }, 404);
        if (target.id === user.id) return json({ error: "Себя выбрать нельзя" }, 400);
        const friendship = db
          .query(
            `SELECT 1 FROM friends WHERE status = 'accepted' AND
             ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
          )
          .get(user.id, target.id, target.id, user.id);
        if (!friendship) return json({ error: `${username} не в друзьях` }, 403);
        targets.push(target);
      }

      if (targets.length === 1 && body?.kind !== "group") {
        const dmKey = [user.id, targets[0].id].sort().join(":");
        const existing = db.query(`SELECT id FROM conversations WHERE dm_key = ?`).get(dmKey) as
          | { id: string }
          | undefined;
        if (existing) {
          return json({ conversation_id: existing.id });
        }
        const convId = uid();
        db.run(
          `INSERT INTO conversations (id, kind, dm_key, name, created_by, created_at) VALUES (?, 'dm', ?, NULL, ?, ?)`,
          [convId, dmKey, user.id, Date.now()]
        );
        db.run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, user.id]);
        db.run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, targets[0].id]);
        return json({ conversation_id: convId }, 201);
      }

      const convId = uid();
      const name = body?.name?.trim().slice(0, 40) || "Группа";
      db.run(
        `INSERT INTO conversations (id, kind, dm_key, name, created_by, created_at) VALUES (?, 'group', NULL, ?, ?, ?)`,
        [convId, name, user.id, Date.now()]
      );
      const all = [user, ...targets];
      for (const member of all) {
        db.run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, member.id]);
      }
      for (const member of all) {
        if (member.id !== user.id) {
          publishToUser(member.id, {
            type: "dm_create",
            conversation: {
              id: convId,
              kind: "group",
              name,
              members: conversationMembers(convId),
            },
          });
        }
      }
      return json({ conversation_id: convId }, 201);
    }

    const dmMessages = pathname.match(/^\/api\/dms\/([a-f0-9]+)\/messages$/);
    if (dmMessages && req.method === "GET") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      if (!isMember(dmMessages[1], user.id)) return json({ error: "Нет доступа" }, 403);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
      const rows = db
        .query(
          `SELECT d.*, u.username, u.display_name, u.avatar_url FROM dm_messages d JOIN users u ON u.id = d.user_id
           WHERE d.conversation_id = ? ORDER BY d.created_at DESC LIMIT ?`
        )
        .all(dmMessages[1], limit) as DmMessageRow[];
      return json({ messages: rows.reverse().map(dmMessageView) });
    }

    if (dmMessages && req.method === "POST") {
      const user = authUser(req);
      if (!user) return json({ error: "Не авторизован" }, 401);
      const conversationId = dmMessages[1];
      if (!isMember(conversationId, user.id)) return json({ error: "Нет доступа" }, 403);
      const body = (await req.json().catch(() => null)) as { content?: string; attachments?: string[] } | null;
      const content = body?.content?.trim() ?? "";
      const attachments = normalizeAttachments(body?.attachments);
      if (!content && attachments.length === 0) return json({ error: "Пустое сообщение" }, 400);
      if (content.length > 2000) return json({ error: "Максимум 2000 символов" }, 400);

      const message: DmMessageRow = {
        id: uid(),
        conversation_id: conversationId,
        user_id: user.id,
        content,
        created_at: Date.now(),
        attachments: JSON.stringify(attachments),
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      };
      db.run(
        `INSERT INTO dm_messages (id, conversation_id, user_id, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)`,
        [message.id, message.conversation_id, message.user_id, message.content, message.created_at, message.attachments]
      );
      const view = dmMessageView(message);
      const members = conversationMembers(conversationId);
      for (const member of members) {
        publishToUser(member.id, { type: "dm", message: view });
      }
      return json({ message: view }, 201);
    }

    return json({ error: "Не найдено" }, 404);
  },
  websocket: {
    open(ws) {
      const token = (ws.data as { token: string | null }).token;
      const user = token
        ? (db.query(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token) as
            | UserRow
            | undefined)
        : undefined;
      if (!user) {
        ws.close(4001, "unauthorized");
        return;
      }
      const data = ws.data as { token: string | null; userId?: string };
      data.userId = user.id;
      ws.subscribe("chat");
      ws.subscribe(`user:${user.id}`);
      const count = (online.get(user.id) ?? 0) + 1;
      online.set(user.id, count);
      if (count === 1) notifyPresence(user.id, true);
    },
    message(ws, raw) {
      const userId = (ws.data as { userId?: string }).userId;
      if (!userId) return;
      let parsed: {
        type?: string;
        channel_id?: string;
        conversation_id?: string;
        content?: string;
        attachments?: string[];
        to?: string;
        payload?: unknown;
      };
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const user = db.query(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow;

      if (parsed.type === "signal" && parsed.to && parsed.payload && typeof parsed.payload === "object") {
        const shared = db
          .query(
            `SELECT 1 FROM conversation_members a
             JOIN conversation_members b ON a.conversation_id = b.conversation_id
             WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`
          )
          .get(userId, parsed.to);
        if (!shared) return;
        publishToUser(parsed.to, {
          type: "signal",
          from: user.id,
          from_username: user.username,
          from_display_name: user.display_name,
          from_avatar_url: user.avatar_url,
          payload: parsed.payload,
        });
        return;
      }

      const content = (parsed.content ?? "").trim().slice(0, 2000);
      const attachments = normalizeAttachments(parsed.attachments);
      if (!content && attachments.length === 0) return;

      if (parsed.type === "message" && parsed.channel_id) {
        const channel = db.query(`SELECT id FROM channels WHERE id = ?`).get(parsed.channel_id) as
          | { id: string }
          | undefined;
        if (!channel) return;
        const message: MessageRow = {
          id: uid(),
          channel_id: channel.id,
          user_id: user.id,
          content,
          created_at: Date.now(),
          attachments: JSON.stringify(attachments),
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
        };
        db.run(
          `INSERT INTO messages (id, channel_id, user_id, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)`,
          [message.id, message.channel_id, message.user_id, message.content, message.created_at, message.attachments]
        );
        server.publish("chat", JSON.stringify({ type: "message", message: messageView(message) }));
        return;
      }

      if (parsed.type === "dm" && parsed.conversation_id) {
        if (!isMember(parsed.conversation_id, user.id)) return;
        const message: DmMessageRow = {
          id: uid(),
          conversation_id: parsed.conversation_id,
          user_id: user.id,
          content,
          created_at: Date.now(),
          attachments: JSON.stringify(attachments),
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
        };
        db.run(
          `INSERT INTO dm_messages (id, conversation_id, user_id, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)`,
          [message.id, message.conversation_id, message.user_id, message.content, message.created_at, message.attachments]
        );
        const view = dmMessageView(message);
        for (const member of conversationMembers(parsed.conversation_id)) {
          publishToUser(member.id, { type: "dm", message: view });
        }
      }
    },
    close(ws) {
      const userId = (ws.data as { userId?: string }).userId;
      if (!userId) return;
      const count = (online.get(userId) ?? 1) - 1;
      if (count <= 0) {
        online.delete(userId);
        notifyPresence(userId, false);
      } else {
        online.set(userId, count);
      }
    },
  },
});

console.log(`waicord server → http://0.0.0.0:${server.port} (db: ${DB_PATH})`);
