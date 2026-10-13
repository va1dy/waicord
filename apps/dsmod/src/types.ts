/**
 * Базовая модель данных (DTO), которую отдаёт API наружу — в UI и в bridge.
 *
 * Внутри лежат «сырые» объекты Discord (`raw`), но их не обязательно парсить:
 * все поля, которые нужны экрану чата, уже разложены по плоским полям.
 * Форматы описаны в docs/api.md.
 */

export type Snowflake = string;

/** Типы каналов Discord (https://discord.com/developers/docs/resources/channel#channel-object-channel-types) */
export enum ChannelType {
  GuildText = 0,
  DM = 1,
  GuildVoice = 2,
  GroupDM = 3,
  GuildCategory = 4,
  GuildAnnouncement = 5,
  AnnouncementThread = 10,
  PublicThread = 11,
  PrivateThread = 12,
  GuildStageVoice = 13,
  GuildDirectory = 14,
  GuildForum = 15,
  GuildMedia = 16,
}

export interface UserDTO {
  id: Snowflake;
  username: string;
  /** Отображаемое имя (global_name), если есть — иначе username */
  displayName: string;
  /** Полный URL аватара или null (тогда UI рисует дефолтный) */
  avatarUrl: string | null;
  /** Индекс дефолтного аватара 0..5 — нужен, если avatarUrl === null */
  defaultAvatarIndex: number;
  bot: boolean;
  /** true для системных пользователей (System, Clyde) */
  system?: boolean;
}

/** Левая панель: всё, что можно открыть как «чат» */
export interface ChatDTO {
  id: Snowflake;
  /** dm | group | guild */
  kind: "dm" | "group" | "guild";
  /** Отображаемое название (для DM — имя собеседника) */
  name: string;
  avatarUrl: string | null;
  /** Собеседники/участники (для group dm и dm) */
  recipients: UserDTO[];
  /** id гильдии, если канал внутри сервера */
  guildId: Snowflake | null;
  /** id категории/родителя (для сортировки в дереве сервера) */
  parentId: Snowflake | null;
  /** id последнего сообщения — им можно сортировать список чатов */
  lastMessageId: Snowflake | null;
  type: ChannelType;
  /** Сырой канал Discord — если UI нужно то, что не вошло в DTO */
  raw: Record<string, unknown>;
}

export interface AttachmentDTO {
  id: Snowflake;
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
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  author?: { name: string; url?: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
}

export interface MessageDTO {
  id: Snowflake;
  channelId: Snowflake;
  author: UserDTO;
  content: string;
  /** ISO-8601 */
  timestamp: string;
  editedTimestamp: string | null;
  attachments: AttachmentDTO[];
  embeds: EmbedDTO[];
  mentions: Snowflake[];
  pinned: boolean;
  /** системные типы сообщений (1 = добавление в друзья и т.п.) */
  type: number;
  flags: number;
  /** id сообщения, на которое это ответ (reply) */
  referenceMessageId: Snowflake | null;
  /** Сырое сообщение Discord */
  raw: Record<string, unknown>;
}

export interface GuildDTO {
  id: Snowflake;
  name: string;
  iconUrl: string | null;
  owner: boolean;
  /** Кол-во участников, если Discord его прислал */
  memberCount: number | null;
  features: string[];
  raw: Record<string, unknown>;
}

/** Фаза голосового подключения (карточка звонка в UI). */
export type VoicePhase =
  /** не в голосе */
  | "idle"
  /** отправлен op4 Voice State Update, ждём session/endpoint */
  | "signalling"
  /* идёт WS/UDP-хендшейк */
  | "connecting"
  /** соединение готово, идёт аудио */
  | "ready"
  /** переподключение (упал сервер/сеть) */
  | "reconnecting"
  /** завершено с ошибкой (кик, лимит попыток) */
  | "disconnected";

/** Состояние E2EE-сессии DAVE (обязательна для звонков с 03.2026). */
export interface VoiceDaveDTO {
  /** Версия протокола (0 — E2EE выключено) */
  version: number;
  /** Готова ли MLS-группа к обмену ключами */
  ready: boolean;
  /** Сравнимый код приватности участников звонка */
  privacyCode: string;
}

/** Голосовое состояние участника: голосовой канал сервера или звонок в ЛС. */
export interface VoiceStateDTO {
  userId: Snowflake;
  /** Для звонка в ЛС — id чата */
  channelId: Snowflake | null;
  guildId: Snowflake | null;
  sessionId: string;
  /** Сервер заглушил участника */
  deaf: boolean;
  mute: boolean;
  selfDeaf: boolean;
  selfMute: boolean;
  selfVideo: boolean;
  suppress: boolean;
  raw: Record<string, unknown>;
}

/** Статус голосового подключения текущего пользователя. */
export interface VoiceConnectionDTO {
  phase: VoicePhase;
  guildId: Snowflake | null;
  /** Голосовой канал; для звонка в ЛС — id чата */
  channelId: Snowflake | null;
  ssrc: number | null;
  /** Режим транспортного шифрования UDP */
  mode: string | null;
  /** Текущие флаги speaking (0 — молчим) */
  speaking: number;
  /** Код закрытия последнего voice-WS, если обрыв уже был */
  closeCode: number | null;
  dave: VoiceDaveDTO;
  participants: VoiceStateDTO[];
}

/** Участник сервера — GET /api/guilds/{id}/members. */
export interface GuildMemberDTO {
  userId: Snowflake;
  user: UserDTO | null;
  nick: string | null;
  /** id ролей участника */
  roles: Snowflake[];
  joinedAt: string | null;
  raw: Record<string, unknown>;
}

/** Роль сервера — GET /api/guilds/{id}/roles. */
export interface RoleDTO {
  id: Snowflake;
  name: string;
  /** Цвет в виде числа 0xRRGGBB */
  color: number;
  /** Права в виде десятичной строки */
  permissions: string;
  /** Отображать отдельной группой в списке участников */
  hoist: boolean;
  mentionable: boolean;
  position: number;
  raw: Record<string, unknown>;
}

export type ChatKind = ChatDTO["kind"];

/** Состояние входа, которое UI отображает на экране логина */
export type AuthChallenge =
  | {
      type: "mfa";
      /** Какие способы подтверждения доступны */
      methods: Array<"totp" | "sms" | "webauthn">;
      ticket: string;
      loginInstanceId: string | null;
      /** Замаскированная почта, если Discord её прислал */
      maskedEmail?: string | null;
    }
  | { type: "phone"; reason: "verification_required"; message: string }
  | { type: "email_code"; reason: "verification_required"; message: string }
  | { type: "captcha"; captchaKey: string | null; captchaSitekey: string | null }
  | { type: "locked"; reason: string; message: string };

export type AuthResult =
  | { ok: true; token: string; user: UserDTO | null }
  | { ok: false; challenge: AuthChallenge | null; error: { code: string; message: string; details?: unknown } };

export type QrStatus = "idle" | "waiting" | "scanned" | "approved" | "cancelled" | "expired" | "error";

export interface QrStateDTO {
  status: QrStatus;
  /** Ссылка для QR-кода (https://discord.com/ra/<fingerprint>) */
  url: string | null;
  /** Готовый QR (data:image/svg+xml;base64,…) — рисовать в UI как <img src> */
  qrImage: string | null;
  fingerprint: string | null;
  expiresAt: string | null;
  /** Кто отсканировал (пока статус scanned/approved) */
  user: { id: Snowflake; username: string; avatarUrl: string | null } | null;
  /** Появляется один раз при status === "approved" — дальше сохранить в сессию */
  token: string | null;
  error: string | null;
}

export interface SessionDTO {
  token: string;
  user: UserDTO | null;
  savedAt: string;
}

export interface GatewayStateDTO {
  connected: boolean;
  sessionId: string | null;
  /** Количество полученных событий с момента старта */
  eventsReceived: number;
  lastEventAt: string | null;
  reconnects: number;
}

export interface StateDTO {
  me: UserDTO | null;
  chats: ChatDTO[];
  gateway: GatewayStateDTO;
}

/** Кадр, который шлёт bridge в WS `/events` */
export interface EventFrame {
  /** Имя gateway-события, например MESSAGE_CREATE */
  t: string;
  /** Данные события */
  d: unknown;
  /** Номер события в сессии (для resume) */
  s: number | null;
  /** ISO-метка времени получения */
  ts: string;
}
