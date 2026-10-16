import {
  authLogin,
  authLogout,
  authMfa,
  authQrCancel,
  authQrStart,
  authQrState,
  authSms,
  authToken,
  callEnd,
  callStart,
  channelMessages,
  EVENTS_URL,
  fetchState,
  guildChannels,
  listGuilds,
  screenStart,
  screenStatus,
  screenStop,
  sendMessage,
  sendTyping,
  voiceJoin,
  voiceLeave,
  voiceOptions,
  voiceSpeaking,
  voiceState,
  voiceStatus,
  type AuthChallenge,
  type ChatDTO,
  type EventFrame,
  type GuildDTO,
  type MessageDTO,
  type QrStateDTO,
  type ScreenStatusDTO,
  type UserDTO,
  type VoiceConnectionDTO,
  type VoiceStateDTO,
} from "./api";

export type ActiveView = { kind: "friends" } | { kind: "chat"; id: string };

export type PresenceMap = Record<string, "online" | "idle" | "dnd" | "offline">;

export interface RelationshipEntry {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  defaultAvatarIndex: number;
  bot?: boolean;
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
  users = $state<Record<string, RelationshipEntry>>({});
  active = $state<ActiveView>({ kind: "friends" });
  wsOpen = $state(false);
  gatewayStatus = $state("idle");
  voice = $state<VoiceConnectionDTO | null>(null);
  screen = $state<ScreenStatusDTO | null>(null);
  pushToTalk = $state(false);
  noiseSuppression = $state(true);
  micActive = $state(false);

  private ws: WebSocket | null = null;
  private guildsLoaded = false;
  private booting: Promise<void> | null = null;
  private bootAt = 0;
  private refreshAt = 0;

  constructor() {
    void this.boot();
    this.connect();
  }

  private boot(force = false): Promise<void> {
    if (this.booting) {
      return force ? this.booting.then(() => this.boot(true)) : this.booting;
    }
    if (!force && Date.now() - this.bootAt < 2000) return Promise.resolve();

    const run = (async () => {
      this.bootError = "";
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const state = await fetchState();
          this.me = state.me;
          this.chats = state.chats;
          this.sortChats();
          this.indexChats();
          this.gatewayStatus = state.gateway.connected ? "ready" : "connecting";
          if (this.me) {
            this.indexUser(this.me);
            await this.loadGuilds();
          }
          this.ready = true;
          return;
        } catch (error) {
          lastError = error;
          await sleep(500);
        }
      }
      this.bootError = lastError instanceof Error ? lastError.message : "Мост недоступен";
      this.ready = true;
    })();

    this.booting = run.finally(() => {
      this.booting = null;
      this.bootAt = Date.now();
    });
    return this.booting;
  }

  private refreshChats() {
    if (Date.now() - this.refreshAt < 2000) return;
    this.refreshAt = Date.now();
    void (async () => {
      try {
        const state = await fetchState();
        this.me = state.me;
        this.chats = state.chats;
        this.sortChats();
        this.indexChats();
      } catch {
        /* keep old data */
      }
    })();
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

    if (t === "DSMOD_HELLO" || t === "DSMOD_PONG") return;
    if (t === "DSMOD_GATEWAY") {
      this.gatewayStatus = String(d.status ?? "idle");
      if (d.status === "ready") void this.refreshChats();
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
        this.users = {};
      } else {
        void this.boot(true);
      }
      return;
    }

    if (t === "READY") {
      this.applyRelationships(d.relationships);
      if (Array.isArray(d.presences)) {
        const next: PresenceMap = { ...this.presence };
        for (const p of d.presences) {
          if (p?.user?.id && p.status) next[p.user.id] = p.status;
        }
        this.presence = next;
      }
      if (Array.isArray(d.users)) {
        for (const u of d.users) {
          const norm = normalizeUser(u);
          if (norm) this.indexUser(norm);
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
    if (!this.me) return;

    if (t === "TYPING_START") {
      const channelId = d.channel_id as string | undefined;
      const userId = d.user_id as string | undefined;
      if (!channelId || !userId || userId === this.me.id) return;
      this.pruneTyping();
      const chat = this.chatById(channelId);
      const name = this.typingName(chat, userId);
      const list = (this.typing[channelId] ?? []).filter((x) => x.name !== name);
      this.typing = { ...this.typing, [channelId]: [...list, { name, at: Date.now() }] };
      return;
    }
    if (t === "CHANNEL_CREATE" || t === "CHANNEL_UPDATE") {
      const chat = normalizeChannel(d);
      if (chat) {
        this.indexChat(chat);
        if (chat.kind === "dm" || chat.kind === "group") this.upsertChat(chat);
        else if (chat.guildId) this.upsertGuildChannel(chat);
      }
      return;
    }
    if (t === "CHANNEL_DELETE") {
      this.chats = this.chats.filter((c) => c.id !== d.id);
      return;
    }
    if (t === "MESSAGE_CREATE" || t === "MESSAGE_UPDATE") {
      const message = normalizeMessage(d);
      if (message) {
        this.indexUser(message.author);
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
      return;
    }

    if (t === "DSMOD_VOICE") {
      this.voice = d as VoiceConnectionDTO;
      return;
    }
    if (t === "DSMOD_VOICE_DAVE") {
      if (this.voice) this.voice = { ...this.voice, dave: d as VoiceConnectionDTO["dave"] };
      return;
    }
    if (t === "DSMOD_VOICE_SPEAKING") {
      const ev = d as { userId: string; ssrc: number; speaking: number };
      if (this.voice) {
        const participants = this.voice.participants.map((p) =>
          p.userId === ev.userId ? { ...p, suppress: ev.speaking === 0 } : p,
        );
        this.voice = { ...this.voice, participants };
      }
      return;
    }
    if (t === "DSMOD_VOICE_AUDIO") {
      const ev = d as { userId: string; pcm: string };
      this.playPcm(ev.pcm);
      return;
    }
    if (t === "DSMOD_SCREEN_STATUS") {
      this.screen = d as ScreenStatusDTO;
      return;
    }
  }

  private typingName(chat: ChatDTO | undefined, userId: string): string {
    const r = chat?.recipients?.find((u) => u.id === userId) ?? this.users[userId];
    return r?.displayName || r?.username || "кто-то";
  }

  private pruneTyping() {
    const now = Date.now();
    let changed = false;
    const next: typeof this.typing = { ...this.typing };
    for (const channelId of Object.keys(next)) {
      const list = next[channelId]!.filter((x) => now - x.at < 8000);
      if (list.length !== next[channelId]!.length) {
        next[channelId] = list;
        changed = true;
      }
    }
    if (changed) this.typing = next;
  }

  private indexUser(u: UserDTO | RelationshipEntry) {
    this.users = {
      ...this.users,
      [u.id]: {
        id: u.id,
        username: u.username,
        displayName: u.displayName || u.username,
        avatarUrl: u.avatarUrl,
        defaultAvatarIndex: u.defaultAvatarIndex,
      },
    };
  }

  private indexChat(chat: ChatDTO) {
    for (const u of chat.recipients ?? []) this.indexUser(u);
  }

  private indexChats() {
    for (const c of this.chats) this.indexChat(c);
  }

  findUserByName(name: string): RelationshipEntry | undefined {
    const q = name.toLowerCase().replace(/^@/, "");
    const pools = [this.friends, this.incoming, this.outgoing, Object.values(this.users)];
    for (const pool of pools) {
      const hit = pool.find((u) => u.username.toLowerCase() === q || u.displayName.toLowerCase() === q);
      if (hit) return hit;
    }
    return undefined;
  }

  userLabel(id: string): string {
    const u = this.users[id] ?? this.friends.find((f) => f.id === id);
    return u ? `@${u.displayName || u.username}` : `@${id}`;
  }

  private applyRelationships(raw: unknown) {
    if (!Array.isArray(raw)) return;
    const friends: RelationshipEntry[] = [];
    const incoming: RelationshipEntry[] = [];
    const outgoing: RelationshipEntry[] = [];
    for (const rel of raw) {
      const entry = relToEntry(rel);
      if (!entry) continue;
      this.indexUser(entry);
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
      this.indexUser(entry);
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
      const entries: Record<string, ChatDTO[]> = {};
      for (const g of guilds) {
        try {
          const channels = await guildChannels(g.id);
          entries[g.id] = channels.filter((c) => c.type === 0 || c.type === 5 || c.type === 2 || c.type === 13);
          for (const c of entries[g.id]!) this.indexChat(c);
        } catch {
          entries[g.id] = [];
        }
        await sleep(450);
      }
      this.guildChannels = entries;
      this.guildsLoaded = true;
      this.error = "";
    } catch (error) {
      if (!this.guildsLoaded) {
        this.error = error instanceof Error ? error.message : "Не удалось загрузить сервера";
      }
    }
  }

  private upsertChat(chat: ChatDTO) {
    const exists = this.chats.some((c) => c.id === chat.id);
    this.chats = exists ? this.chats.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...this.chats];
    this.sortChats();
  }

  private upsertGuildChannel(chat: ChatDTO) {
    const gid = chat.guildId;
    if (!gid) return;
    const list = this.guildChannels[gid] ?? [];
    const exists = list.some((c) => c.id === chat.id);
    this.guildChannels = {
      ...this.guildChannels,
      [gid]: exists ? list.map((c) => (c.id === chat.id ? chat : c)) : [...list, chat],
    };
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
    this.messages = {
      ...this.messages,
      [message.channelId]: [...list, message].sort((a, b) => cmpId(a.id, b.id)),
    };
    if (message.author.id !== this.me?.id && view !== message.channelId) {
      this.unread = { ...this.unread, [message.channelId]: (this.unread[message.channelId] ?? 0) + 1 };
    }
  }

  private touchChat(message: MessageDTO) {
    const chat = this.chatById(message.channelId);
    if (chat?.guildId) {
      const list = this.guildChannels[chat.guildId] ?? [];
      this.guildChannels = {
        ...this.guildChannels,
        [chat.guildId]: list.map((c) => (c.id === chat.id ? { ...c, lastMessageId: message.id } : c)),
      };
    } else if (chat) {
      this.upsertChat({ ...chat, lastMessageId: message.id });
    } else {
      void this.refreshChats();
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
    await this.boot(true);
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
    await this.boot(true);
    return null;
  }

  async loginToken(token: string): Promise<void> {
    const res = await authToken(token);
    if (!res.authenticated) throw new Error("Токен не принят");
    await this.boot(true);
  }

  async loginSms(ticket: string): Promise<string> {
    const res = await authSms(ticket);
    return res.phone;
  }

  async bootAfterQr(): Promise<void> {
    await this.boot(true);
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
    this.users = {};
    this.guildsLoaded = false;
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
    if (!id) return;
    try {
      const fetched = await channelMessages(id, { limit: 50 });
      for (const m of fetched) this.indexUser(m.author);
      const existing = this.messages[id] ?? [];
      const seen = new Set(fetched.map((m) => m.id));
      const merged = [...fetched, ...existing.filter((m) => !seen.has(m.id))].sort((a, b) =>
        cmpId(a.id, b.id),
      );
      this.messages = { ...this.messages, [id]: merged };
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

  async joinVoice(channelId: string, guildId?: string | null): Promise<void> {
    try {
      this.voice = await voiceJoin(channelId, guildId);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось подключиться к голосу";
    }
  }

  async leaveVoice(): Promise<void> {
    try {
      this.voice = await voiceLeave();
    } catch {
      /* best-effort */
    }
  }

  async toggleMute(): Promise<void> {
    if (!this.voice) return;
    const me = this.voice.participants.find((p) => p.userId === this.me?.id);
    const next = !this.voice.dave.ready ? false : !(me?.selfMute ?? false);
    try {
      this.voice = await voiceState({ selfMute: next });
    } catch {
      /* best-effort */
    }
  }

  async toggleDeaf(): Promise<void> {
    if (!this.voice) return;
    const me = this.voice.participants.find((p) => p.userId === this.me?.id);
    const next = !(me?.selfDeaf ?? false);
    try {
      this.voice = await voiceState({ selfDeaf: next });
    } catch {
      /* best-effort */
    }
  }

  async setSpeaking(speaking: boolean): Promise<void> {
    if (!this.voice) return;
    try {
      this.voice = await voiceSpeaking(speaking ? 1 : 0);
    } catch {
      /* best-effort */
    }
  }

  async startCall(chatId: string): Promise<void> {
    try {
      this.voice = await callStart(chatId);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось начать звонок";
    }
  }

  async endCall(chatId: string): Promise<void> {
    try {
      this.voice = await callEnd(chatId);
    } catch {
      /* best-effort */
    }
  }

  async startScreenShare(fps?: number, width?: number): Promise<void> {
    try {
      this.screen = await screenStart({ fps, width });
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось начать трансляцию";
    }
  }

  async stopScreenShare(): Promise<void> {
    try {
      this.screen = await screenStop();
    } catch {
      /* best-effort */
    }
  }

  async refreshScreenStatus(): Promise<void> {
    try {
      this.screen = await screenStatus();
    } catch {
      /* best-effort */
    }
  }

  async setPushToTalk(enabled: boolean): Promise<void> {
    this.pushToTalk = enabled;
  }

  async setNoiseSuppression(enabled: boolean): Promise<void> {
    this.noiseSuppression = enabled;
  }

  async setMicActive(active: boolean): Promise<void> {
    this.micActive = active;
    if (!active) await this.setSpeaking(false);
  }

  private audioCtx: AudioContext | null = null;

  async playPcm(base64: string): Promise<void> {
    try {
      const raw = atob(base64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      const buf = this.audioCtx.createBuffer(1, float32.length, 48000);
      buf.copyToChannel(float32, 0);
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.audioCtx.destination);
      src.start();
    } catch {
    }
  }

  isInVoice(): boolean {
    return this.voice !== null && this.voice.phase !== "idle" && this.voice.phase !== "disconnected";
  }

  isScreenSharing(): boolean {
    return this.screen?.active ?? false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snow(id: string | null): number {
  if (!id) return 0;
  try {
    return Number(BigInt(id) / 1000000000000n);
  } catch {
    return 0;
  }
}

function cmpId(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

function defaultIndex(id: string): number {
  try {
    return Number(BigInt(id) % 6n);
  } catch {
    return 0;
  }
}

function normalizeUser(raw: any): (RelationshipEntry & { bot: boolean }) | null {
  if (!raw?.id) return null;
  const id = String(raw.id);
  return {
    id,
    username: String(raw.username ?? ""),
    displayName: String(raw.global_name ?? raw.globalName ?? raw.username ?? ""),
    avatarUrl: raw.avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${raw.avatar}.png?size=64`
      : null,
    defaultAvatarIndex: defaultIndex(id),
    bot: Boolean(raw.bot),
  };
}

function normalizeMessage(raw: any): MessageDTO | null {
  if (!raw?.id || !raw?.author?.id) return null;
  const author = normalizeUser(raw.author);
  if (!author) return null;
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map((a: any, i: number) => ({
        id: String(a.id ?? i),
        filename: String(a.filename ?? "file"),
        url: String(a.url ?? ""),
        proxyUrl: String(a.proxy_url ?? a.proxyUrl ?? a.url ?? ""),
        width: a.width ?? null,
        height: a.height ?? null,
        size: a.size,
        contentType: a.content_type ?? a.contentType ?? null,
      }))
    : [];
  const embeds = Array.isArray(raw.embeds) ? raw.embeds : [];
  const mentions = Array.isArray(raw.mentions)
    ? raw.mentions.map((u: any) => String(u?.id ?? "")).filter(Boolean)
    : [];
  return {
    id: String(raw.id),
    channelId: String(raw.channel_id ?? raw.channelId ?? ""),
    author,
    content: String(raw.content ?? ""),
    timestamp: String(raw.timestamp ?? new Date().toISOString()),
    editedTimestamp: raw.edited_timestamp ?? raw.editedTimestamp ?? null,
    attachments,
    embeds,
    mentions,
    pinned: Boolean(raw.pinned),
    type: Number(raw.type ?? 0),
    referenceMessageId: raw.message_reference?.message_id ?? raw.referenceMessageId ?? null,
  };
}

function normalizeChannel(raw: any): ChatDTO | null {
  if (!raw?.id) return null;
  const type = Number(raw.type ?? 0);
  const kind: ChatDTO["kind"] = type === 1 ? "dm" : type === 3 ? "group" : "guild";
  const recipients = Array.isArray(raw.recipients)
    ? (raw.recipients.map((u: any) => normalizeUser(u)).filter(Boolean) as RelationshipEntry[]).map(
        (u) => u as unknown as UserDTO,
      )
    : [];
  return {
    id: String(raw.id),
    kind,
    name: String(raw.name ?? ""),
    avatarUrl: raw.icon ? `https://cdn.discordapp.com/icons/${raw.id}/${raw.icon}.png?size=64` : null,
    recipients,
    guildId: raw.guild_id ? String(raw.guild_id) : null,
    parentId: raw.parent_id ? String(raw.parent_id) : null,
    lastMessageId: raw.last_message_id ? String(raw.last_message_id) : null,
    type,
    raw,
  };
}

function relToEntry(rel: unknown): RelationshipEntry | null {
  return normalizeUser((rel as { user?: Record<string, unknown> })?.user);
}

export const app = new AppState();
