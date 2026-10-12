export interface User {
  id: string;
  username: string;
  email: string;
  created_at: number;
  display_name?: string | null;
  status?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
}

export interface UserBrief {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  status?: string | null;
  online?: boolean;
}

export interface Session {
  server: string;
  token: string;
  user: User;
}

export interface Channel {
  id: string;
  name: string;
  created_at: number;
}

export type Attachment = string | { url: string; name?: string };

export function attUrl(a: Attachment): string {
  return typeof a === "string" ? a : a.url;
}

export function attName(a: Attachment): string {
  if (typeof a === "string") return decodeURIComponent(a.split("/").pop() ?? "файл");
  return a.name || decodeURIComponent(a.url.split("/").pop() ?? "файл");
}

export function resolveAttUrl(a: Attachment, base: string): string {
  const url = attUrl(a);
  if (url.startsWith("/")) return base.replace(/\/$/, "") + url;
  return url;
}

export interface Message {
  id: string;
  channel_id?: string;
  conversation_id?: string;
  content: string;
  created_at: number;
  attachments?: Attachment[];
  user: UserBrief;
}

export interface FriendEntry {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  status?: string | null;
  online?: boolean;
  request_id?: string;
}

export interface DmConversation {
  id: string;
  kind: "dm" | "group";
  name: string | null;
  members: UserBrief[];
  last: { content: string; created_at: number; username: string } | null;
}

export function normalizeServer(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

async function request<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    throw new Error("Сервер недоступен — проверь адрес");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `Ошибка сервера (${res.status})`);
  return data as T;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function health(base: string): Promise<{ ok: boolean; name: string; version: string }> {
  return request(base, "/api/health");
}

export async function login(base: string, identifier: string, password: string): Promise<{ token: string; user: User }> {
  return request(base, "/api/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password }),
  });
}

export async function register(
  base: string,
  username: string,
  email: string,
  password: string,
): Promise<{ token: string; user: User }> {
  return request(base, "/api/register", {
    method: "POST",
    body: JSON.stringify({ username, email, password }),
  });
}

export async function me(base: string, token: string): Promise<{ user: User }> {
  return request(base, "/api/me", { headers: auth(token) });
}

export async function listChannels(base: string, token: string): Promise<{ channels: Channel[] }> {
  return request(base, "/api/channels", { headers: auth(token) });
}

export async function createChannel(base: string, token: string, name: string): Promise<{ channel: Channel }> {
  return request(base, "/api/channels", {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ name }),
  });
}

export async function channelMessages(
  base: string,
  token: string,
  channelId: string,
): Promise<{ messages: Message[] }> {
  return request(base, `/api/channels/${channelId}/messages`, { headers: auth(token) });
}

export async function sendChannelMessage(
  base: string,
  token: string,
  channelId: string,
  content: string,
  attachments: Attachment[] = [],
): Promise<{ message: Message }> {
  return request(base, `/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ content, attachments }),
  });
}

export async function listFriends(
  base: string,
  token: string,
): Promise<{ friends: FriendEntry[]; incoming: FriendEntry[]; outgoing: FriendEntry[] }> {
  return request(base, "/api/friends", { headers: auth(token) });
}

export async function sendFriendRequest(
  base: string,
  token: string,
  username: string,
): Promise<{ ok: boolean; accepted?: boolean; request_id?: string }> {
  return request(base, "/api/friends/requests", {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ username }),
  });
}

export async function acceptFriendRequest(base: string, token: string, requestId: string): Promise<{ ok: boolean }> {
  return request(base, `/api/friends/requests/${requestId}/accept`, {
    method: "POST",
    headers: auth(token),
  });
}

export async function declineFriendRequest(base: string, token: string, requestId: string): Promise<{ ok: boolean }> {
  return request(base, `/api/friends/requests/${requestId}/decline`, {
    method: "POST",
    headers: auth(token),
  });
}

export async function removeFriend(base: string, token: string, userId: string): Promise<{ ok: boolean }> {
  return request(base, `/api/friends/${userId}`, { method: "DELETE", headers: auth(token) });
}

export async function listDms(base: string, token: string): Promise<{ conversations: DmConversation[] }> {
  return request(base, "/api/dms", { headers: auth(token) });
}

export async function createDm(
  base: string,
  token: string,
  usernames: string[],
  name?: string,
  kind?: "dm" | "group",
): Promise<{ conversation_id: string }> {
  return request(base, "/api/dms", {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ usernames, name, kind }),
  });
}

export async function dmMessages(base: string, token: string, conversationId: string): Promise<{ messages: Message[] }> {
  return request(base, `/api/dms/${conversationId}/messages`, { headers: auth(token) });
}

export async function sendDmMessage(
  base: string,
  token: string,
  conversationId: string,
  content: string,
  attachments: Attachment[] = [],
): Promise<{ message: Message }> {
  return request(base, `/api/dms/${conversationId}/messages`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ content, attachments }),
  });
}

export async function uploadFile(
  base: string,
  token: string,
  file: File,
): Promise<{ url: string; name: string; size: number }> {
  const data = await fileToBase64(file);
  const res = await request<{ url: string; name: string; size: number }>(base, "/api/upload", {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ name: file.name, data }),
  });
  return { ...res, url: base.replace(/\/$/, "") + res.url };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1]! : result);
    };
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

export async function updateMe(
  base: string,
  token: string,
  patch: { display_name?: string; status?: string; bio?: string; avatar_url?: string | null },
): Promise<{ user: User }> {
  return request(base, "/api/me", {
    method: "PATCH",
    headers: auth(token),
    body: JSON.stringify(patch),
  });
}

const GIPHY_KEY = "dc6zaTOxFJmzC";

export async function searchGifs(query: string, limit = 12): Promise<string[]> {
  const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(query)}&limit=${limit}&rating=g&lang=ru`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Giphy недоступен — попробуй позже или загрузи GIF файлом");
  }
  const data = (await res.json().catch(() => null)) as {
    data?: { images?: { fixed_width?: { url?: string } } }[];
  } | null;
  if (!res.ok || !data?.data) throw new Error("Не удалось найти гифки");
  return data.data.map((g) => g.images?.fixed_width?.url ?? "").filter(Boolean);
}

const SESSION_KEY = "waicord.session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}
