const BASE = "http://127.0.0.1:8787";

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  defaultAvatarIndex: number;
  bot: boolean;
}

export interface AttachmentDTO {
  id: string;
  filename: string;
  url: string;
  proxyUrl: string;
  width?: number | null;
  height?: number | null;
  size?: number;
  contentType?: string | null;
}

export interface EmbedDTO {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  image?: { url: string };
  thumbnail?: { url: string };
}

export interface MessageDTO {
  id: string;
  channelId: string;
  author: UserDTO;
  content: string;
  timestamp: string;
  editedTimestamp: string | null;
  attachments: AttachmentDTO[];
  embeds: EmbedDTO[];
  mentions: string[];
  pinned: boolean;
  type: number;
  referenceMessageId: string | null;
}

export interface ChatDTO {
  id: string;
  kind: "dm" | "group" | "guild";
  name: string;
  avatarUrl: string | null;
  recipients: UserDTO[];
  guildId: string | null;
  parentId: string | null;
  lastMessageId: string | null;
  type: number;
  raw: Record<string, unknown>;
}

export interface GuildDTO {
  id: string;
  name: string;
  iconUrl: string | null;
  owner: boolean;
  memberCount: number | null;
  features: string[];
}

export interface GatewayStateDTO {
  connected: boolean;
  sessionId: string | null;
  eventsReceived: number;
  lastEventAt: string | null;
  reconnects: number;
}

export interface StateDTO {
  me: UserDTO | null;
  chats: ChatDTO[];
  gateway: GatewayStateDTO;
}

export type AuthChallenge =
  | { type: "mfa"; methods: Array<"totp" | "sms" | "webauthn">; ticket: string; loginInstanceId: string | null; maskedEmail?: string | null }
  | { type: "phone"; reason: string; message: string }
  | { type: "email_code"; reason: string; message: string }
  | { type: "captcha"; captchaKey: string | null; captchaSitekey: string | null }
  | { type: "locked"; reason: string; message: string };

export interface AuthResponse {
  authenticated: boolean;
  me: UserDTO | null;
  challenge: AuthChallenge | null;
  error: { code: string; message: string } | null;
}

export interface QrStateDTO {
  status: "idle" | "waiting" | "scanned" | "approved" | "cancelled" | "expired" | "error";
  url: string | null;
  qrImage: string | null;
  fingerprint: string | null;
  expiresAt: string | null;
  user: { id: string; username: string; avatarUrl: string | null } | null;
  token: string | null;
  error: string | null;
}

export interface EventFrame {
  t: string;
  d: unknown;
  s: number | null;
  ts: string;
}

export const EVENTS_URL = "ws://127.0.0.1:8787/events";

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: init?.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error("Мост dsmod не запущен — запусти `bun start` в apps/dsmod");
  }
  const payload = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }
    | null;
  if (!payload) throw new Error(`Мост ответил неожиданно (${res.status})`);
  if (!payload.ok) throw new Error(payload.error.message || "Ошибка моста");
  return payload.data;
}

export function fetchState(): Promise<StateDTO> {
  return request("/api/state");
}

export function authLogin(email: string, password: string): Promise<AuthResponse> {
  return request("/api/auth/login", { method: "POST", body: { email, password } });
}

export function authMfa(payload: {
  ticket: string;
  loginInstanceId: string | null;
  method: "totp" | "sms";
  code: string;
}): Promise<AuthResponse> {
  return request("/api/auth/mfa", { method: "POST", body: payload });
}

export function authSms(ticket: string): Promise<{ phone: string }> {
  return request("/api/auth/sms", { method: "POST", body: { ticket } });
}

export function authToken(token: string): Promise<{ authenticated: boolean; me: UserDTO | null }> {
  return request("/api/auth/token", { method: "POST", body: { token } });
}

export function authQrStart(): Promise<{ url: string; qrImage: string | null; state: QrStateDTO }> {
  return request("/api/auth/qr", { method: "POST" });
}

export function authQrState(): Promise<QrStateDTO> {
  return request("/api/auth/qr");
}

export function authQrCancel(): Promise<QrStateDTO> {
  return request("/api/auth/qr/cancel", { method: "POST" });
}

export function authLogout(): Promise<{ authenticated: boolean }> {
  return request("/api/auth/logout", { method: "POST" });
}

export function channelMessages(
  channelId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<MessageDTO[]> {
  const q = new URLSearchParams();
  q.set("limit", String(opts.limit ?? 50));
  if (opts.before) q.set("before", opts.before);
  return request(`/api/channels/${channelId}/messages?${q}`);
}

export function sendMessage(channelId: string, content: string): Promise<MessageDTO> {
  return request(`/api/channels/${channelId}/messages`, { method: "POST", body: { content } });
}

export function sendTyping(channelId: string): Promise<{ ok: true }> {
  return request(`/api/channels/${channelId}/typing`, { method: "POST" });
}

export function listGuilds(): Promise<GuildDTO[]> {
  return request("/api/guilds");
}

export function guildChannels(guildId: string): Promise<ChatDTO[]> {
  return request(`/api/guilds/${guildId}/channels`);
}

export function defaultAvatarUrl(u: Pick<UserDTO, "defaultAvatarIndex">): string {
  return `https://cdn.discordapp.com/embed/avatars/${u.defaultAvatarIndex}.png`;
}

export function avatarOf(u: Pick<UserDTO, "avatarUrl" | "defaultAvatarIndex"> | null | undefined): string | null {
  return u?.avatarUrl ?? (u ? defaultAvatarUrl(u) : null);
}

const GIPHY_KEY = "dc6zaTOxFJmzC";

export async function searchGifs(query: string, limit = 12): Promise<string[]> {
  const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(query)}&limit=${limit}&rating=g&lang=ru`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Giphy недоступен — попробуй позже");
  }
  const data = (await res.json().catch(() => null)) as {
    data?: { images?: { fixed_width?: { url?: string } } }[];
  } | null;
  if (!res.ok || !data?.data) throw new Error("Не удалось найти гифки");
  return data.data.map((g) => g.images?.fixed_width?.url ?? "").filter(Boolean);
}
