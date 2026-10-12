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
  return request(base, "/api/me", { headers: { Authorization: `Bearer ${token}` } });
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
