import type { AttachmentDTO, ChatDTO, EmbedDTO, GuildDTO, MessageDTO, UserDTO } from "./types";
import { ChannelType } from "./types";

type Raw = Record<string, any>;

const CDN = "https://cdn.discordapp.com";

export function defaultAvatarUrl(index: number): string {
  return `${CDN}/embed/avatars/${index % 6}.png`;
}

function defaultAvatarIndex(user: Raw): number {
  const discriminator = user.discriminator;
  if (discriminator && discriminator !== "0") return Number(discriminator) % 5;
  try {
    return Number((BigInt(String(user.id)) >> 22n) % 6n);
  } catch {
    return 0;
  }
}

/** Обычный объект пользователя Discord → компактный DTO для UI. */
export function toUser(user: Raw): UserDTO {
  const avatar = user.avatar ?? null;
  return {
    id: String(user.id ?? "0"),
    username: String(user.username ?? ""),
    displayName: String(user.global_name || user.display_name || user.username || ""),
    avatarUrl: avatar ? `${CDN}/avatars/${user.id}/${avatar}.png?size=128` : null,
    defaultAvatarIndex: defaultAvatarIndex(user),
    bot: Boolean(user.bot),
    system: Boolean(user.system),
  };
}

export function attachmentToDto(attachment: Raw): AttachmentDTO {
  return {
    id: String(attachment.id ?? ""),
    filename: String(attachment.filename ?? ""),
    url: String(attachment.url ?? ""),
    proxyUrl: String(attachment.proxy_url ?? attachment.url ?? ""),
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    size: attachment.size,
    contentType: attachment.content_type ?? null,
  };
}

export function embedToDto(embed: Raw): EmbedDTO {
  return {
    title: embed.title,
    description: embed.description,
    url: embed.url,
    color: embed.color,
    timestamp: embed.timestamp,
    footer: embed.footer,
    author: embed.author,
    image: embed.image,
    thumbnail: embed.thumbnail,
  };
}

function chatKind(type: number): ChatDTO["kind"] {
  if (type === ChannelType.DM) return "dm";
  if (type === ChannelType.GroupDM) return "group";
  return "guild";
}

function chatName(type: number, channel: Raw, recipients: UserDTO[]): string {
  if (type === ChannelType.DM) return recipients[0]?.displayName || recipients[0]?.username || "DM";
  if (type === ChannelType.GroupDM) {
    if (channel.name) return String(channel.name);
    return recipients.map((r) => r.displayName || r.username).join(", ") || "Group DM";
  }
  return String(channel.name ?? "channel");
}

function chatAvatar(type: number, channel: Raw, recipients: UserDTO[]): string | null {
  if (type === ChannelType.DM) {
    const peer = recipients[0];
    return peer ? (peer.avatarUrl ?? defaultAvatarUrl(peer.defaultAvatarIndex)) : null;
  }
  if (type === ChannelType.GroupDM && channel.icon) {
    return `${CDN}/channel-icons/${channel.id}/${channel.icon}.png?size=128`;
  }
  return null;
}

/** Канал Discord (DM / group DM / канал сервера) → элемент левой панели. */
export function toChat(channel: Raw): ChatDTO {
  const type = Number(channel.type ?? ChannelType.GuildText);
  const recipients: UserDTO[] = Array.isArray(channel.recipients) ? channel.recipients.map(toUser) : [];
  return {
    id: String(channel.id),
    kind: chatKind(type),
    name: chatName(type, channel, recipients),
    avatarUrl: chatAvatar(type, channel, recipients),
    recipients,
    guildId: channel.guild_id ? String(channel.guild_id) : null,
    parentId: channel.parent_id ? String(channel.parent_id) : null,
    lastMessageId: channel.last_message_id ? String(channel.last_message_id) : null,
    type,
    raw: channel,
  };
}

/** Сообщение Discord → DTO, который рендерит любая безлимитная лента. */
export function toMessage(message: Raw): MessageDTO {
  const author = message.author ?? { id: message.webhook_id ?? "0", username: "system" };
  return {
    id: String(message.id),
    channelId: String(message.channel_id),
    author: toUser(author),
    content: String(message.content ?? ""),
    timestamp: String(message.timestamp ?? ""),
    editedTimestamp: message.edited_timestamp ?? null,
    attachments: Array.isArray(message.attachments) ? message.attachments.map(attachmentToDto) : [],
    embeds: Array.isArray(message.embeds) ? message.embeds.map(embedToDto) : [],
    mentions: Array.isArray(message.mentions) ? message.mentions.map((m: Raw) => String(m.id)) : [],
    pinned: Boolean(message.pinned),
    type: Number(message.type ?? 0),
    flags: Number(message.flags ?? 0),
    referenceMessageId: message.message_reference?.message_id ? String(message.message_reference.message_id) : null,
    raw: message,
  };
}

/** Гильдия (сервер) → DTO для списка серверов. */
export function toGuild(guild: Raw): GuildDTO {
  return {
    id: String(guild.id),
    name: String(guild.name ?? ""),
    iconUrl: guild.icon ? `${CDN}/icons/${guild.id}/${guild.icon}.png?size=128` : null,
    owner: Boolean(guild.owner),
    memberCount: guild.member_count ?? null,
    features: Array.isArray(guild.features) ? guild.features : [],
    raw: guild,
  };
}

/** Сортировка чатов: свежие переписки сверху (по id последнего сообщения). */
export function byLastMessage(a: ChatDTO, b: ChatDTO): number {
  if (!a.lastMessageId) return 1;
  if (!b.lastMessageId) return -1;
  if (a.lastMessageId === b.lastMessageId) return 0;
  return BigInt(a.lastMessageId) < BigInt(b.lastMessageId) ? 1 : -1;
}
