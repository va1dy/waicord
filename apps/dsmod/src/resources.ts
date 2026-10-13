import { byLastMessage, toChat, toGuild, toMessage, toUser } from "./dto";
import type { DiscordRest } from "./http/client";
import type { ChatDTO, GuildDTO, MessageDTO, Snowflake, UserDTO } from "./types";

export interface MessageQuery {
  /** 1..100, по умолчанию 50 */
  limit?: number;
  /** id сообщения, до которого читать назад (пагинация) */
  before?: Snowflake;
  /** id сообщения, после которого читать вперёд */
  after?: Snowflake;
  /** id сообщения, вокруг которого читать */
  around?: Snowflake;
}

export interface SendMessagePayload {
  content?: string;
  /** Список id вложений, если файлы уже загружены */
  attachment_ids?: Snowflake[];
  tts?: boolean;
  embeds?: unknown[];
  sticker_ids?: Snowflake[];
  flags?: number;
  /** Ответ на сообщение */
  reply_to?: Snowflake;
  nonce?: string;
}

/**
 * Ресурсы Discord, нужные чату.
 * Ссылки на официальную документацию — в docs/discord-reference.md.
 */
export class Resources {
  constructor(private readonly rest: DiscordRest) {}

  /** Текущий пользователь — GET /users/@me */
  async me(): Promise<UserDTO> {
    return toUser(await this.rest.get<Record<string, any>>("/users/@me"));
  }

  /** Пользователь по id — GET /users/{user.id} */
  async user(id: Snowflake): Promise<UserDTO> {
    return toUser(await this.rest.get<Record<string, any>>(`/users/${id}`));
  }

  /**
   * Все личные переписки (DM + group DM) — GET /users/@me/channels.
   * Отсортированы по последнему сообщению: свежие сверху.
   */
  async chats(): Promise<ChatDTO[]> {
    const channels = await this.rest.get<Record<string, any>[]>("/users/@me/channels");
    return channels.map(toChat).sort(byLastMessage);
  }

  /** Канал/чат по id — GET /channels/{channel.id} */
  async chat(id: Snowflake): Promise<ChatDTO> {
    return toChat(await this.rest.get<Record<string, any>>(`/channels/${id}`));
  }

  /** Серверы пользователя — GET /users/@me/guilds */
  async guilds(): Promise<GuildDTO[]> {
    const guilds = await this.rest.get<Record<string, any>[]>("/users/@me/guilds");
    return guilds.map(toGuild);
  }

  /** Сервер по id — GET /guilds/{guild.id} */
  async guild(id: Snowflake): Promise<GuildDTO> {
    return toGuild(await this.rest.get<Record<string, any>>(`/guilds/${id}`));
  }

  /** Все каналы сервера — GET /guilds/{guild.id}/channels */
  async guildChats(id: Snowflake): Promise<ChatDTO[]> {
    const channels = await this.rest.get<Record<string, any>[]>(`/guilds/${id}/channels`);
    return channels.map(toChat);
  }

  /** Сообщения канала — GET /channels/{channel.id}/messages */
  async messages(channelId: Snowflake, query: MessageQuery = {}): Promise<MessageDTO[]> {
    const messages = await this.rest.get<Record<string, any>[]>(`/channels/${channelId}/messages`, {
      query: { limit: query.limit ?? 50, before: query.before, after: query.after, around: query.around },
    });
    return messages.map(toMessage);
  }

  /** Одно сообщение — GET /channels/{channel.id}/messages/{message.id} */
  async message(channelId: Snowflake, messageId: Snowflake): Promise<MessageDTO> {
    return toMessage(await this.rest.get<Record<string, any>>(`/channels/${channelId}/messages/${messageId}`));
  }

  /** Отправить сообщение — POST /channels/{channel.id}/messages */
  async send(channelId: Snowflake, payload: string | SendMessagePayload): Promise<MessageDTO> {
    const body: SendMessagePayload = typeof payload === "string" ? { content: payload } : payload;
    if (body.reply_to) {
      body.nonce ??= String(Date.now());
      // message_reference — так Discord понимает «ответ на сообщение»
      (body as any).message_reference = { message_id: body.reply_to, fail_if_not_exists: false };
      delete body.reply_to;
    }
    return toMessage(await this.rest.post<Record<string, any>>(`/channels/${channelId}/messages`, body));
  }

  /** Изменить своё сообщение — PATCH /channels/{channel.id}/messages/{message.id} */
  async edit(channelId: Snowflake, messageId: Snowflake, payload: { content?: string; flags?: number }): Promise<MessageDTO> {
    return toMessage(
      await this.rest.patch<Record<string, any>>(`/channels/${channelId}/messages/${messageId}`, payload),
    );
  }

  /** Удалить сообщение — DELETE /channels/{channel.id}/messages/{message.id} */
  async remove(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await this.rest.del(`/channels/${channelId}/messages/${messageId}`);
  }

  /** Сообщить, что пользователь печатает — POST /channels/{channel.id}/typing */
  async typing(channelId: Snowflake): Promise<void> {
    await this.rest.post(`/channels/${channelId}/typing`);
  }

  /** Открыть ЛС с пользователем (или вернуть существующее) — POST /users/@me/channels */
  async createDm(userId: Snowflake): Promise<ChatDTO> {
    return toChat(await this.rest.post<Record<string, any>>("/users/@me/channels", { recipient_id: userId }));
  }

  /** Закрепить сообщение — PUT /channels/{channel.id}/pins/{message.id} */
  async pin(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await this.rest.put(`/channels/${channelId}/messages/pins/${messageId}`);
  }

  /** Открепить сообщение — DELETE /channels/{channel.id}/pins/{message.id} */
  async unpin(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await this.rest.del(`/channels/${channelId}/messages/pins/${messageId}`);
  }

  /** Закреплённые сообщения — GET /channels/{channel.id}/messages/pins */
  async pins(channelId: Snowflake): Promise<MessageDTO[]> {
    const messages = await this.rest.get<Record<string, any>[]>(`/channels/${channelId}/messages/pins`);
    return messages.map(toMessage);
  }
}
