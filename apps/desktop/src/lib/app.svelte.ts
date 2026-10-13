import {
  authLogin,
  authLogout,
  authMfa,
  authQrCancel,
  authQrStart,
  authQrState,
  authSms,
  authToken,
  channelMessages,
  EVENTS_URL,
  fetchState,
  guildChannels,
  listGuilds,
  sendMessage,
  sendTyping,
  type AuthChallenge,
  type ChatDTO,
  type EventFrame,
  type GuildDTO,
  type MessageDTO,
  type QrStateDTO,
  type UserDTO,
} from "./api";

export type ActiveView = { kind: "friends" } | { kind: "chat"; id: string };

export type PresenceMap = Record<string, "online" | "idle" | "dnd" | "offline">;

export interface RelationshipEntry {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  defaultAvatarIndex: number;
}

class AppState {
  me = $state<UserDTO | null>(null);
  ready = $state(false);
  bootError = $state("");
  error = $state("");
  chats = $state<ChatDTO[]>([]);
  guilds = $state<GuildDTO[]>([]);
  guildChannels = $state<Record<string, ChatDTO[]>>({});
  messages = $state<Record<string, MessageDTO[]>>({});
  unread = $state<Record<string, number>>({});
  typing = $state<Record<string, { name: string; at: number }[]>>({});
  presence = $state<PresenceMap>({});
  friends = $state<RelationshipEntry[]>([]);
  incoming = $state<RelationshipEntry[]>([]);
  outgoing = $state<RelationshipEntry[]>([]);
  active = $state<ActiveView>({ kind: "friends" });
  wsOpen = $state(false);
  gatewayStatus = $state("idle");

  private ws: WebSocket | null = null;

  constructor() {
    void this.boot();
    this.connect();
  }

  private async boot() {
    this.bootError = "";
    try {
      const state = await fetchState();
      this.me = state.me;
      this.chats = state.chats;
      this.gatewayStatus = state.gateway.connected ? "ready" : "connecting";
      if (this.me) await this.loadGuilds();
    } catch (error) {
      this.bootError = error instanceof Error ? error.message : "Мост недоступен";
    } finally {
      this.ready = true;
    }
  }

  private connect() {
    this.ws?.close();
    const ws = new WebSocket(EVENTS_URL);
    ws.onopen = () => {
      this.wsOpen = true;
      void this.boot();
    };
    ws.onclose = () => {
      this.wsOpen = false;
      setTimeout(() => this.connect(), 3000);
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)) as EventFrame);
      } catch {
        /* ignore malformed */
      }
    };
    this.ws = ws;
  }

  private handle(frame: EventFrame) {
    const t = frame.t;
    const d = frame.d as Record<string, any>;

    if (t === "DSMOD_GATEWAY") {
      this.gatewayStatus = String(d.status ?? "idle");
      return;
    }
    if (t === "DSMOD_AUTH") {
      if (!d.authenticated) {
        this.me = null;
        this.chats = [];
        this.messages = {};
        this.friends = [];
        this.incoming = [];
        this.outgoing = [];
      } else {
        void this.boot();
      }
      return;
    }
    if (!this.me) return;

    if (t === "READY") {
      this.applyRelationships(d.relationships);
      if (Array.isArray(d.presences)) {
        for (const p of d.presences) {
          if (p?.user?.id && p.status) this.presence = { ...this.presence, [p.user.id]: p.status };
        }
      }
      return;
    }
    if (t === "RELATIONSHIP_ADD" || t === "RELATIONSHIP_REMOVE") {
      this.applyRawRelationship(d);
      return;
    }
    if (t === "PRESENCE_UPDATE") {
      const id = d?.user?.id as string | undefined;
      if (id && d.status) this.presence = { ...this.presence, [id]: d.status };
      return;
    }
    if (t === "TYPING_START") {
      const channelId = d.channel_id as string | undefined;
      const userId = d.user_id as string | undefined;
      if (!channelId || !userId || userId === this.me.id) return;
      const chat = this.chatById(channelId);
      const name = this.typingName(chat, userId);
      const list = (this.typing[channelId] ?? []).filter((x) => x.name !== name);
      this.typing = { ...this.typing, [channelId]: [...list, { name, at: Date.now() }] };
      return;
    }
    if (t === "CHANNEL_CREATE" || t === "CHANNEL_UPDATE") {
      const chat = d as unknown as ChatDTO;
      if (chat?.id && chat.kind) this.upsertChat(chat);
      return;
    }
    if (t === "CHANNEL_DELETE") {
      this.chats = this.chats.filter((c) => c.id !== d.id);
      return;
    }
    if (t === "MESSAGE_CREATE" || t === "MESSAGE_UPDATE") {
      const message = d as unknown as MessageDTO;
      if (message?.id && message.channelId) {
        this.pushMessage(message);
        this.touchChat(message);
      }
      return;
    }
    if (t === "MESSAGE_DELETE") {
      const channelId = d.channel_id as string | undefined;
      const id = d.id as string | undefined;
      if (channelId && id) {
        const list = this.messages[channelId];
        if (list) this.messages = { ...this.messages, [channelId]: list.filter((m) => m.id !== id) };
      }
    }
  }

  private typingName(chat: ChatDTO | undefined, userId: string): string {
    const r = chat?.recipients?.find((u) => u.id === userId);
    return r?.displayName || r?.username || "кто-то";
  }

  private applyRelationships(raw: unknown) {
    if (!Array.isArray(raw)) return;
    const friends: RelationshipEntry[] = [];
    const incoming: RelationshipEntry[] = [];
    const outgoing: RelationshipEntry[] = [];
    for (const rel of raw) {
      const entry = relToEntry(rel);
      if (!entry) continue;
      if (rel.type === 1) friends.push(entry);
      else if (rel.type === 3) incoming.push(entry);
      else if (rel.type === 4) outgoing.push(entry);
    }
    this.friends = friends.sort((a, b) => a.username.localeCompare(b.username));
    this.incoming = incoming;
    this.outgoing = outgoing;
  }

  private applyRawRelationship(rel: { id?: string; type?: number; user?: Record<string, unknown> }) {
    if (!rel?.user?.id) return;
    if (rel.type === 1 || rel.type === 3 || rel.type === 4) {
      const entry = relToEntry(rel);
      if (!entry) return;
      if (rel.type === 1) {
        this.friends = [...this.friends.filter((f) => f.id !== entry.id), entry].sort((a, b) =>
          a.username.localeCompare(b.username),
        );
        this.incoming = this.incoming.filter((f) => f.id !== entry.id);
        this.outgoing = this.outgoing.filter((f) => f.id !== entry.id);
      } else if (rel.type === 3) {
        this.incoming = [...this.incoming.filter((f) => f.id !== entry.id), entry];
      } else {
        this.outgoing = [...this.outgoing.filter((f) => f.id !== entry.id), entry];
      }
      return;
    }
    this.friends = this.friends.filter((f) => f.id !== rel.id);
    this.incoming = this.incoming.filter((f) => f.id !== rel.id);
    this.outgoing = this.outgoing.filter((f) => f.id !== rel.id);
  }

  private async loadGuilds() {
    try {
      const guilds = await listGuilds();
      this.guilds = guilds;
      const entries = await Promise.all(
        guilds.map(async (g) => {
          const channels = await guildChannels(g.id);
          return [g.id, channels.filter((c) => c.type === 0 || c.type === 5)] as const;
        }),
      );
      this.guildChannels = Object.fromEntries(entries);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось загрузить сервера";
    }
  }

  private upsertChat(chat: ChatDTO) {
    const exists = this.chats.some((c) => c.id === chat.id);
    this.chats = exists ? this.chats.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...this.chats];
    this.sortChats();
  }

  private sortChats() {
    this.chats = [...this.chats].sort((a, b) => snow(b.lastMessageId) - snow(a.lastMessageId));
  }

  private chatById(id: string): ChatDTO | undefined {
    return (
      this.chats.find((c) => c.id === id) ??
      Object.values(this.guildChannels).flat().find((c) => c.id === id)
    );
  }

  private pushMessage(message: MessageDTO) {
    const list = this.messages[message.channelId] ?? [];
    const idx = list.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      const next = [...list];
      next[idx] = { ...next[idx]!, ...message };
      this.messages = { ...this.messages, [message.channelId]: next };
      return;
    }
    const view = this.viewKey();
    this.messages = { ...this.messages, [message.channelId]: [...list, message] };
    if (message.author.id !== this.me?.id && view !== message.channelId) {
      this.unread = { ...this.unread, [message.channelId]: (this.unread[message.channelId] ?? 0) + 1 };
    }
  }

  private touchChat(message: MessageDTO) {
    const chat = this.chatById(message.channelId);
    if (chat) {
      this.upsertChat({ ...chat, lastMessageId: message.id });
    } else {
      void this.boot();
    }
  }

  viewKey(): string {
    return this.active.kind === "chat" ? this.active.id : "";
  }

  pendingCount(): number {
    return this.incoming.length + this.outgoing.length;
  }

  private clearUnread(id: string) {
    if (this.unread[id]) this.unread = { ...this.unread, [id]: 0 };
  }

  async loginPassword(email: string, password: string): Promise<AuthChallenge | null> {
    const res = await authLogin(email, password);
    if (!res.authenticated) {
      if (res.error) throw new Error(res.error.message);
      return res.challenge;
    }
    await this.boot();
    return null;
  }

  async loginMfa(payload: {
    ticket: string;
    loginInstanceId: string | null;
    method: "totp" | "sms";
    code: string;
  }): Promise<AuthChallenge | null> {
    const res = await authMfa(payload);
    if (!res.authenticated) {
      if (res.error) throw new Error(res.error.message);
      return res.challenge;
    }
    await this.boot();
    return null;
  }

  async loginToken(token: string): Promise<void> {
    const res = await authToken(token);
    if (!res.authenticated) throw new Error("Токен не принят");
    await this.boot();
  }

  async loginSms(ticket: string): Promise<string> {
    const res = await authSms(ticket);
    return res.phone;
  }

  async bootAfterQr(): Promise<void> {
    await this.boot();
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      await sendTyping(channelId);
    } catch {
      /* typing is best-effort */
    }
  }

  startQr(): Promise<{ url: string; qrImage: string | null; state: QrStateDTO }> {
    return authQrStart();
  }

  qrState(): Promise<QrStateDTO> {
    return authQrState();
  }

  cancelQr(): Promise<QrStateDTO> {
    return authQrCancel();
  }

  async logout() {
    try {
      await authLogout();
    } catch {
      /* bridge may be down */
    }
    this.me = null;
    this.chats = [];
    this.guilds = [];
    this.guildChannels = {};
    this.messages = {};
    this.unread = {};
    this.friends = [];
    this.incoming = [];
    this.outgoing = [];
    this.active = { kind: "friends" };
    this.gatewayStatus = "idle";
  }

  async openFriends() {
    this.active = { kind: "friends" };
  }

  async openChat(id: string) {
    this.active = { kind: "chat", id };
    this.clearUnread(id);
    await this.ensureHistory();
  }

  private async ensureHistory() {
    const id = this.viewKey();
    if (!id || this.messages[id]) return;
    try {
      const messages = await channelMessages(id, { limit: 50 });
      this.messages = { ...this.messages, [id]: messages };
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось загрузить историю";
    }
  }

  async sendMessage(content: string): Promise<void> {
    const id = this.viewKey();
    const text = content.trim();
    if (!id || !text) return;
    await sendMessage(id, text);
  }
}

function snow(id: string | null): number {
  if (!id) return 0;
  try {
    return Number(BigInt(id) / 1000000000000n);
  } catch {
    return 0;
  }
}

function relToEntry(rel: unknown): RelationshipEntry | null {
  const r = rel as { user?: Record<string, unknown> };
  const u = r?.user;
  if (!u?.id) return null;
  return {
    id: String(u.id),
    username: String(u.username ?? ""),
    displayName: String(u.global_name ?? u.username ?? ""),
    avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    defaultAvatarIndex: Number(u.id ? Number(BigInt(String(u.id)) % 6n) : 0),
  };
}

export const app = new AppState();
