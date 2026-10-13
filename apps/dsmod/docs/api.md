# API

Два уровня, выбирай любой:

1. **HTTP-мост** (`http://127.0.0.1:8787`) — то, на что смотрит UI. JSON везде, без токена на клиенте.
2. **SDK** (`src/index.ts`) — те же операции напрямую из TypeScript.

Оба уровня используют одни и те же DTO и одинаковые коды ошибок.

---

## Общий контракт HTTP

**Успешный ответ**

```json
{ "ok": true, "data": { ... } }
```

**Ошибка**

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "...", "details": null } }
```

| HTTP | `error.code` | Когда |
|---|---|---|
| 400 | `invalid_body` | не хватает обязательного поля |
| 401 | `unauthorized` | нет входа (или неверный `x-dsmod-key`) |
| 401/403/404/429 | `discord_<status>` | ответ Discord, `details.discordCode` — код Discord |
| 404 | `not_found` | нет такого маршрута |
| 429 | превышен rate-limit Discord | `details.retryAfter` — секунды |
| 500 | `internal_error` | непредвиденное |

Заголовки: `Content-Type: application/json`, `Access-Control-Allow-Origin: *` —
поэтому работает из браузера, Tauri-webview и `file://`.

Если мост запущен с `--key secret` (или `DSMOD_KEY`), каждый запрос, кроме
`GET /api/health`, должен нести заголовок `x-dsmod-key: secret`.

### Фреймы WebSocket `/events`

```json
{ "t": "MESSAGE_CREATE", "d": { ... }, "s": 42, "ts": "2026-10-12T16:41:49.010Z" }
```

`t` — имя события: либо реальное событие Gateway (`MESSAGE_CREATE`), либо служебное
(`DSMOD_HELLO`, `DSMOD_AUTH`, `DSMOD_QR`, `DSMOD_GATEWAY`, `DSMOD_PONG`).
После подключения клиент может отправить строку `ping` → придёт `DSMOD_PONG`.

---

## HTTP-эндпоинты

### Служебные

| Метод | Путь | Ответ `data` |
|---|---|---|
| GET | `/` | демо-интерфейс (HTML), если он найден |
| GET | `/api` | индекс эндпоинтов (JSON) |
| GET | `/api/health` | `{status, authenticated, gateway, sessionId}` |
| GET | `/api/state` | `{me, chats, gateway}` — всё, что нужно экрану при старте |

### Вход

| Метод | Путь | Тело | Ответ `data` |
|---|---|---|---|
| POST | `/api/auth/login` | `{email, password}` | `{authenticated, me, challenge, error}` |
| POST | `/api/auth/mfa` | `{ticket, loginInstanceId, method:"totp"\|"sms", code}` | то же |
| POST | `/api/auth/sms` | `{ticket}` | `{phone}` (маскированный номер) |
| POST | `/api/auth/token` | `{token}` | `{authenticated, me}` |
| POST | `/api/auth/qr` | — | `{url, qrImage, state}` |
| GET | `/api/auth/qr` | — | `QrStateDTO` (см. ниже) |
| POST | `/api/auth/qr/cancel` | — | `QrStateDTO` |
| POST | `/api/auth/logout` | — | `{authenticated:false}` |

`login`/`mfa` **всегда** отвечают 200: успешный вход — `authenticated:true`,
иначе `challenge` (что запросил Discord) и `error` (что сказать человеку).

### Чаты и сообщения

| Метод | Путь | Тело / query | Ответ `data` |
|---|---|---|---|
| GET | `/api/me` | — | `UserDTO` |
| GET | `/api/chats` | — | `ChatDTO[]` (сортировка: свежие сверху) |
| GET | `/api/chats/{id}` | — | `ChatDTO` |
| GET | `/api/channels/{id}/messages` | `?limit=50&before=&after=&around=` | `MessageDTO[]` (новые первыми) |
| POST | `/api/channels/{id}/messages` | `{content, reply_to?, tts?, embeds?, flags?, nonce?}` | `MessageDTO` |
| POST | `/api/channels/{id}/typing` | — | `{ok:true}` |
| GET | `/api/channels/{id}/pins` | — | `MessageDTO[]` |
| PATCH | `/api/messages/{channelId}/{messageId}` | `{content}` | `MessageDTO` |
| DELETE | `/api/messages/{channelId}/{messageId}` | — | `{deleted:true}` |
| GET | `/api/guilds` | — | `GuildDTO[]` |
| GET | `/api/guilds/{id}` | — | `GuildDTO` |
| GET | `/api/guilds/{id}/channels` | — | `ChatDTO[]` |

`limit` ограничен 100 (ограничение Discord). Пагинация — через `before=<id последнего
сообщения>`.

---

## DTO

Все поля плоские и стабильные; сырой объект Discord лежит в `raw`, если что-то понадобится.

### UserDTO

| Поле | Тип | Комментарий |
|---|---|---|
| `id` | string | snowflake |
| `username` | string | уникальный логин |
| `displayName` | string | `global_name` или `username` |
| `avatarUrl` | string \| null | `null` → рисовать `defaultAvatarIndex` |
| `defaultAvatarIndex` | number | 0..5, URL `cdn.discordapp.com/embed/avatars/{n}.png` |
| `bot` | boolean | |

### ChatDTO

| Поле | Тип | Комментарий |
|---|---|---|
| `id` | string | id канала — его используют все сообщения |
| `kind` | `"dm" \| "group" \| "guild"` | для UI: ЛС / групповой / канал сервера |
| `name` | string | у ЛС — имя собеседника |
| `avatarUrl` | string \| null | |
| `recipients` | `UserDTO[]` | собеседники/участники |
| `guildId` | string \| null | |
| `parentId` | string \| null | категория (для дерева сервера) |
| `lastMessageId` | string \| null | для сортировки списка |
| `type` | number | сырой тип канала Discord (1=DM, 3=group, 0=text…) |
| `raw` | object | |

### MessageDTO

| Поле | Тип | Комментарий |
|---|---|---|
| `id` | string | |
| `channelId` | string | |
| `author` | `UserDTO` | |
| `content` | string | текст (может быть пустым — только вложения) |
| `timestamp` | string | ISO-8601 |
| `editedTimestamp` | string \| null | |
| `attachments` | `AttachmentDTO[]` | `{id, filename, url, proxyUrl, width, height, size, contentType}` |
| `embeds` | `EmbedDTO[]` | `{title, description, url, color, image, thumbnail, footer, author, timestamp}` |
| `mentions` | string[] | id упомянутых |
| `pinned` | boolean | |
| `type` | number | 0 — обычное, 19 — ответ (reply) и т.д. |
| `referenceMessageId` | string \| null | id сообщения, на которое это ответ |

### GuildDTO

`{id, name, iconUrl, owner, memberCount, features, raw}`

### QrStateDTO

`{status, url, qrImage, fingerprint, expiresAt, user, token, error}`

- `status`: `idle → waiting → scanned → approved | cancelled | expired | error`
- `qrImage`: `data:image/svg+xml;base64,...` — сразу в `<img src>`
- `token`: возвращается **один раз** при `approved`; дальше ориентируйся на `status`

### EventFrame

`{t, d, s, ts}` — см. [events.md](events.md).

---

## SDK (`src/index.ts`)

```ts
import { createClient, DscClient } from "./src/index";
```

### DscClient

| Метод / поле | Что делает |
|---|---|
| `createClient(options?)` | создаёт клиент и подхватывает сессию с диска |
| `client.isAuthenticated` | есть ли токен |
| `client.restore()` | загрузить сессию из `~/.dsmod/session.json` |
| `client.login({email,password})` | `Promise<AuthResult>` |
| `client.solveMfa({ticket,loginInstanceId},{code,method})` | `Promise<AuthResult>` |
| `client.startQr(opts?)` | `QrSession`: `await start()`, `waitForToken()`, `cancel()` |
| `client.useToken(token)` | подставить токен вручную |
| `client.logout()` | выйти + удалить сессию |
| `client.loadMe()` | `GET /users/@me` → `UserDTO` |
| `client.connect()` / `disconnect()` | gateway |
| `client.on("MESSAGE_CREATE", fn)` | события (`d` — сырой объект Discord) |
| `client.api` | все методы ресурсов (ниже) |
| `client.rest` | низкоуровневый REST (`get/post/patch/put/del`) |

### `client.api` (Resources)

| Метод | Discord endpoint |
|---|---|
| `me()` | `GET /users/@me` |
| `user(id)` | `GET /users/{user.id}` |
| `chats()` | `GET /users/@me/channels` |
| `chat(id)` | `GET /channels/{channel.id}` |
| `guilds()` | `GET /users/@me/guilds` |
| `guild(id)` | `GET /guilds/{guild.id}` |
| `guildChats(id)` | `GET /guilds/{guild.id}/channels` |
| `messages(channelId, {limit,before,after,around})` | `GET /channels/{id}/messages` |
| `message(channelId, messageId)` | `GET /channels/{id}/messages/{id}` |
| `send(channelId, text \| payload)` | `POST /channels/{id}/messages` |
| `edit(channelId, messageId, {content})` | `PATCH /channels/{id}/messages/{id}` |
| `remove(channelId, messageId)` | `DELETE /channels/{id}/messages/{id}` |
| `typing(channelId)` | `POST /channels/{id}/typing` |
| `createDm(userId)` | `POST /users/@me/channels` |
| `pin/unpin/pins(channelId, messageId?)` | пин-эндпоинты |

`send` принимает строку или объект; поле `reply_to` превращается в `message_reference`.

### Ошибки

```ts
import { DiscordApiError, UnauthorizedError, RateLimitError, DsmodError } from "./src/index";

try {
  await client.api.send(id, "hi");
} catch (e) {
  if (e instanceof DiscordApiError) console.log(e.status, e.discordCode, e.message);
}
```

---

## Rate limits

`DiscordRest` читает `X-RateLimit-*` и `retry_after`:

- до запроса ждёт, если bucket исчерпан;
- при 429 повторяет до 3 раз с паузой;
- при исчерпании бросает `RateLimitError`.

Практический совет для UI: не опрашивать `/api/chats` чаще раза в несколько секунд —
живые обновления приходят через `/events`.
