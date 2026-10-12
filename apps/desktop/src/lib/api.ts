export interface User {
  id: string;
  username: string;
  email: string;
  created_at: number;
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

export interface Message {
  id: string;
  channel_id?: string;
  conversation_id?: string;
  content: string;
  created_at: number;
  user: { id: string; username: string };
}

export interface FriendEntry {
  id: string;
  username: string;
  online?: boolean;
  request_id?: string;
}

export interface DmConversation {
  id: string;
  kind: "dm" | "group";
  name: string | null;
  members: { id: string; username: string }[];
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
): Promise<{ message: Message }> {
  return request(base, `/api/channels/${channelId}/messages`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ content }),
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
): Promise<{ message: Message }> {
  return request(base, `/api/dms/${conversationId}/messages`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ content }),
  });
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
