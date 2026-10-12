import {
  acceptFriendRequest,
  channelMessages,
  clearSession,
  createDm,
  declineFriendRequest,
  dmMessages,
  listChannels,
  listDms,
  listFriends,
  loadSession,
  removeFriend,
  saveSession,
  sendChannelMessage,
  sendDmMessage,
  sendFriendRequest,
  type Channel,
  type DmConversation,
  type FriendEntry,
  type Message,
  type Session,
} from "./api";

export type ActiveView = { kind: "friends" } | { kind: "channel"; id: string } | { kind: "dm"; id: string };

type WsEvent =
  | { type: "message"; message: Message }
  | { type: "dm"; message: Message }
  | { type: "friend_request"; from: { id: string; username: string } }
  | { type: "friend_accept"; from: { id: string; username: string } }
  | { type: "friend_remove"; from: { id: string; username: string } }
  | { type: "dm_create"; conversation: DmConversation }
  | { type: "presence"; user_id: string; online: boolean };

class AppState {
  session = $state<Session | null>(null);
  channels = $state<Channel[]>([]);
  dms = $state<DmConversation[]>([]);
  friends = $state<FriendEntry[]>([]);
  incoming = $state<FriendEntry[]>([]);
  outgoing = $state<FriendEntry[]>([]);
  messages = $state<Record<string, Message[]>>({});
  active = $state<ActiveView>({ kind: "friends" });
  wsOpen = $state(false);
  ready = $state(false);
  error = $state("");

  private ws: WebSocket | null = null;

  constructor() {
    this.session = loadSession();
    if (this.session) void this.boot();
    else this.ready = true;
  }

  get base(): string {
    return this.session?.server ?? "";
  }

  get token(): string {
    return this.session?.token ?? "";
  }

  get incomingCount(): number {
    return this.incoming.length;
  }

  private async boot() {
    if (!this.session) return;
    await this.refreshAll();
    this.connect();
  }

  async loginWith(session: Session) {
    saveSession(session);
    this.session = session;
    this.error = "";
    await this.boot();
  }

  logout() {
    this.ws?.close();
    this.ws = null;
    clearSession();
    this.session = null;
    this.channels = [];
    this.dms = [];
    this.friends = [];
    this.incoming = [];
    this.outgoing = [];
    this.messages = {};
    this.active = { kind: "friends" };
    this.wsOpen = false;
  }

  private connect() {
    const s = this.session;
    if (!s) return;
    this.ws?.close();
    const wsBase = s.server.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(s.token)}`);
    ws.onopen = () => {
      this.wsOpen = true;
    };
    ws.onclose = () => {
      this.wsOpen = false;
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)) as WsEvent);
      } catch {
        /* ignore malformed */
      }
    };
    this.ws = ws;
  }

  private handle(event: WsEvent) {
    if (event.type === "message" && event.message.channel_id) {
      this.pushMessage(`c:${event.message.channel_id}`, event.message);
      return;
    }
    if (event.type === "dm" && event.message.conversation_id) {
      this.pushMessage(`d:${event.message.conversation_id}`, event.message);
      this.touchDm(event.message.conversation_id, event.message);
      const known = this.dms.some((d) => d.id === event.message.conversation_id);
      if (!known) void this.refreshDms();
      return;
    }
    if (event.type === "dm_create") {
      if (!this.dms.some((d) => d.id === event.conversation.id)) {
        this.dms = [event.conversation, ...this.dms];
      }
      return;
    }
    if (event.type === "friend_request" || event.type === "friend_accept" || event.type === "friend_remove") {
      void this.refreshFriends();
      return;
    }
    if (event.type === "presence") {
      this.friends = this.friends.map((f) => (f.id === event.user_id ? { ...f, online: event.online } : f));
    }
  }

  private pushMessage(key: string, message: Message) {
    const list = this.messages[key] ?? [];
    if (list.some((m) => m.id === message.id)) return;
    this.messages[key] = [...list, message];
  }

  private touchDm(conversationId: string, message: Message) {
    this.dms = this.dms.map((d) =>
      d.id === conversationId
        ? { ...d, last: { content: message.content, created_at: message.created_at, username: message.user.username } }
        : d,
    );
  }

  async refreshAll() {
    if (!this.session) return;
    this.error = "";
    try {
      await Promise.all([this.refreshChannels(), this.refreshFriends(), this.refreshDms()]);
      const view = this.active;
      if (view.kind === "channel" && !this.channels.some((c) => c.id === view.id)) {
        this.active = { kind: "friends" };
      }
      if (view.kind === "dm" && !this.dms.some((d) => d.id === view.id)) {
        this.active = { kind: "friends" };
      }
      if (this.active.kind !== "friends") await this.ensureHistory();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось загрузить данные";
    } finally {
      this.ready = true;
    }
  }

  async refreshChannels() {
    if (!this.session) return;
    const { channels } = await listChannels(this.base, this.token);
    this.channels = channels;
  }

  async refreshFriends() {
    if (!this.session) return;
    const { friends, incoming, outgoing } = await listFriends(this.base, this.token);
    this.friends = friends;
    this.incoming = incoming;
    this.outgoing = outgoing;
  }

  async refreshDms() {
    if (!this.session) return;
    const { conversations } = await listDms(this.base, this.token);
    this.dms = conversations;
  }

  viewKey(view: ActiveView = this.active): string {
    if (view.kind === "channel") return `c:${view.id}`;
    if (view.kind === "dm") return `d:${view.id}`;
    return "";
  }

  private async ensureHistory() {
    if (!this.session) return;
    const key = this.viewKey();
    if (!key || this.messages[key]) return;
    const view = this.active;
    try {
      if (view.kind === "channel") {
        const { messages } = await channelMessages(this.base, this.token, view.id);
        this.messages[key] = messages;
      } else if (view.kind === "dm") {
        const { messages } = await dmMessages(this.base, this.token, view.id);
        this.messages[key] = messages;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось загрузить историю";
    }
  }

  async openFriends() {
    this.active = { kind: "friends" };
    await this.refreshFriends();
  }

  async openChannel(id: string) {
    this.active = { kind: "channel", id };
    await this.ensureHistory();
  }

  async openDm(id: string) {
    this.active = { kind: "dm", id };
    await this.ensureHistory();
  }

  async sendMessage(content: string) {
    if (!this.session) return;
    const text = content.trim();
    if (!text) return;
    const view = this.active;
    if (view.kind === "channel") {
      await sendChannelMessage(this.base, this.token, view.id, text);
    } else if (view.kind === "dm") {
      await sendDmMessage(this.base, this.token, view.id, text);
    }
  }

  async addFriend(username: string): Promise<string> {
    if (!this.session) throw new Error("Нет сессии");
    const result = await sendFriendRequest(this.base, this.token, username);
    await this.refreshFriends();
    return result.accepted ? "Вы теперь друзья" : "Заявка отправлена";
  }

  async acceptRequest(requestId: string) {
    if (!this.session) return;
    await acceptFriendRequest(this.base, this.token, requestId);
    await this.refreshFriends();
  }

  async declineRequest(requestId: string) {
    if (!this.session) return;
    await declineFriendRequest(this.base, this.token, requestId);
    await this.refreshFriends();
  }

  async deleteFriend(userId: string) {
    if (!this.session) return;
    await removeFriend(this.base, this.token, userId);
    await this.refreshFriends();
  }

  async startDm(username: string): Promise<string> {
    if (!this.session) throw new Error("Нет сессии");
    const { conversation_id } = await createDm(this.base, this.token, [username]);
    await this.refreshDms();
    await this.openDm(conversation_id);
    return conversation_id;
  }

  async createGroup(usernames: string[], name?: string): Promise<string> {
    if (!this.session) throw new Error("Нет сессии");
    const { conversation_id } = await createDm(this.base, this.token, usernames, name, "group");
    await this.refreshDms();
    await this.openDm(conversation_id);
    return conversation_id;
  }

  async addChannel(name: string) {
    if (!this.session) return;
    const { createChannel } = await import("./api");
    await createChannel(this.base, this.token, name);
    await this.refreshChannels();
  }
}

export const app = new AppState();
