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
| 503 | `gateway_required` | Gateway не подключён — нельзя войти в голос |
| 409 | `not_in_voice` | нет активного голосового подключения |
| 409 | `conflict` | звонок идёт в другом канале |

Заголовки: `Content-Type: application/json`, `Access-Control-Allow-Origin: *` —
поэтому работает из браузера, Tauri-webview и `file://`.

Если мост запущен с `--key secret` (или `DSMOD_KEY`), каждый запрос, кроме
`GET /api/health`, должен нести заголовок `x-dsmod-key: secret`.

### Фреймы WebSocket `/events`

```json
{ "t": "MESSAGE_CREATE", "d": { ... }, "s": 42, "ts": "2026-10-12T16:41:49.010Z" }
```

`t` — имя события: либо реальное событие Gateway (`MESSAGE_CREATE`), либо служебное
(`DSMOD_HELLO`, `DSMOD_AUTH`, `DSMOD_QR`, `DSMOD_GATEWAY`, `DSMOD_PONG`,
`DSMOD_VOICE*`, `DSMOD_SCREEN_STATUS`, `DSMOD_SCREEN_FRAME`, `DSMOD_DEBUG` —
см. [events.md](events.md)).
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
| GET | `/api/channels/{id}` | — | `ChatDTO` — любой канал, включая голосовые (type 2/13) |
| GET | `/api/channels/{id}/messages` | `?limit=50&before=&after=&around=` | `MessageDTO[]` (новые первыми) |
| POST | `/api/channels/{id}/messages` | `{content, reply_to?, tts?, embeds?, flags?, nonce?}` | `MessageDTO` |
| POST | `/api/channels/{id}/typing` | — | `{ok:true}` |
| GET | `/api/channels/{id}/pins` | — | `MessageDTO[]` |
| PATCH | `/api/messages/{channelId}/{messageId}` | `{content}` | `MessageDTO` |
| DELETE | `/api/messages/{channelId}/{messageId}` | — | `{deleted:true}` |
| GET | `/api/guilds` | — | `GuildDTO[]` |
| GET | `/api/guilds/{id}` | — | `GuildDTO` |
| GET | `/api/guilds/{id}/channels` | — | `ChatDTO[]` |
| GET | `/api/guilds/{id}/members` | `?limit=1..100&after=<snowflake>` | `GuildMemberDTO[]` (limit по умолчанию 100, after — для пагинации) |
| GET | `/api/guilds/{id}/roles` | — | `RoleDTO[]` |

`limit` ограничен 100 (ограничение Discord). Пагинация — через `before=<id последнего
сообщения>`.

### Голос

| Метод | Путь | Тело | Ответ `data` |
|---|---|---|---|
| GET | `/api/voice` | — | `VoiceConnectionDTO` — статус голосового подключения |
| POST | `/api/voice/join` | `{channelId, guildId?, selfMute?, selfDeaf?}` | `VoiceConnectionDTO` |
| POST | `/api/voice/leave` | — | `VoiceConnectionDTO` (`phase → idle`) |
| POST | `/api/voice/state` | `{selfMute?, selfDeaf?}` | `VoiceConnectionDTO` |
| POST | `/api/voice/speaking` | `{speaking}` | `VoiceConnectionDTO` |
| POST | `/api/voice/audio` | `{pcm}` | `{sent}` |
| POST | `/api/voice/options` | `{forwardAudio?}` | `{forwardAudio}` |
| POST | `/api/chats/{id}/call` | — | `VoiceConnectionDTO` — начать звонок в ЛС |
| DELETE | `/api/chats/{id}/call` | — | `VoiceConnectionDTO` — закончить звонок |
| GET | `/api/voice/stream` | — | `VoiceStreamDTO` — статус трансляции экрана |
| POST | `/api/voice/stream/start` | `{width?, height?, fps?, bitrateKbps?, source?}` | `VoiceConnectionDTO` — начать Go Live |
| POST | `/api/voice/stream/stop` | — | `VoiceConnectionDTO` — закончить Go Live |

- `guildId: null` / нет поля — звонок в ЛС (`channelId` = id чата).
- `state`/`speaking`/`audio` без активного подключения → ошибка `not_in_voice`.
- `speaking`: `boolean | number` (битовая маска: 1 — голос).
- `pcm` — base64 PCM **s16le, 48 кГц, стерео, длина кратна 3840 байтам** (3840 байт =
  20 мс); иначе `invalid_body`. `sent` — число отправленных 20-мс фреймов.
- `options` включает рассылку входящего аудио в UI (`DSMOD_VOICE_AUDIO`).
- `DELETE /api/chats/{id}/call` при звонке в другом канале → ошибка `conflict`.

Подробности протокола — [voice.md](voice.md).

### Демонстрация экрана

| Метод | Путь | Тело | Ответ `data` |
|---|---|---|---|
| GET | `/api/screen` | — | `ScreenStatus` |
| POST | `/api/screen/start` | `{fps?, width?}` | `ScreenStatus` |
| POST | `/api/screen/stop` | — | `ScreenStatus` |

`fps` — 1..10 (по умолчанию 2), `width` — 320..1920 px (по умолчанию 1280); повторный
`start` — перезапуск с новыми параметрами. Кадры приходят событием `DSMOD_SCREEN_FRAME`.

Это локальный захват для UI (превью); видео в Discord — `POST /api/voice/stream/start`
(подробности — [voice.md](voice.md), раздел «Go Live»).

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

### VoicePhase

`"idle" | "signalling" | "connecting" | "ready" | "reconnecting" | "disconnected"`

Фазы переходов и таймауты — в [voice.md](voice.md).

### VoiceStreamPhase

`"idle" | "signalling" | "connecting" | "live" | "error"`

Фазы трансляции и её устройства — в [voice.md](voice.md), раздел «Go Live».

### VoiceDaveDTO

Состояние E2EE-сессии DAVE.

| Поле | Тип | Комментарий |
|---|---|---|
| `version` | number | версия протокола (0 — E2EE выключено) |
| `ready` | boolean | готова ли MLS-группа к обмену ключами |
| `privacyCode` | string | сравнимый код приватности участников звонка |

### VoiceStateDTO

Голосовое состояние участника: голосовой канал сервера или звонок в ЛС.

| Поле | Тип | Комментарий |
|---|---|---|
| `userId` | string | snowflake |
| `channelId` | string \| null | для звонка в ЛС — id чата |
| `guildId` | string \| null | `null` для звонка в ЛС |
| `sessionId` | string | |
| `deaf` | boolean | сервер заглушил участника |
| `mute` | boolean | сервер заглушил участника |
| `selfDeaf` | boolean | |
| `selfMute` | boolean | |
| `selfVideo` | boolean | |
| `suppress` | boolean | |
| `raw` | object | |

### VoiceConnectionDTO

Статус голосового подключения текущего пользователя.

| Поле | Тип | Комментарий |
|---|---|---|
| `phase` | `VoicePhase` | |
| `guildId` | string \| null | `null` для звонка в ЛС |
| `channelId` | string \| null | голосовой канал; для звонка в ЛС — id чата |
| `ssrc` | number \| null | |
| `mode` | string \| null | режим транспортного шифрования UDP |
| `speaking` | number | текущие флаги speaking (0 — молчим) |
| `closeCode` | number \| null | код закрытия последнего voice-WS, если обрыв уже был |
| `dave` | `VoiceDaveDTO` | |
| `participants` | `VoiceStateDTO[]` | участники канала |
| `stream` | `VoiceStreamDTO` | состояние Go Live-трансляции |

### VoiceStreamDTO

Состояние трансляции экрана (Go Live) текущего пользователя.

| Поле | Тип | Комментарий |
|---|---|---|
| `phase` | `VoiceStreamPhase` | |
| `key` | string \| null | stream_key `guild:{guildId}:{channelId}:{userId}` |
| `width` | number \| null | ширина видео в px |
| `height` | number \| null | высота видео в px |
| `fps` | number \| null | |
| `bitrateKbps` | number \| null | |
| `ssrc` | number \| null | |
| `mode` | string \| null | режим транспортного шифрования стрим-соединения |
| `frames` | number | кадров отправлено с начала трансляции |
| `bytes` | number | байт H264 отправлено с начала трансляции |
| `startedAt` | string \| null | ISO-8601 — когда пошли кадры |
| `error` | string \| null | текст последней ошибки (`phase error`) |

### GuildMemberDTO

Участник сервера.

| Поле | Тип | Комментарий |
|---|---|---|
| `userId` | string | snowflake |
| `user` | `UserDTO` \| null | |
| `nick` | string \| null | |
| `roles` | string[] | id ролей участника |
| `joinedAt` | string \| null | ISO-8601 |
| `raw` | object | |

### RoleDTO

Роль сервера.

| Поле | Тип | Комментарий |
|---|---|---|
| `id` | string | snowflake |
| `name` | string | |
| `color` | number | 0xRRGGBB |
| `permissions` | string | десятичная строка |
| `hoist` | boolean | отображать отдельной группой |
| `mentionable` | boolean | |
| `position` | number | |
| `raw` | object | |

### ScreenStatus

| Поле | Тип | Комментарий |
|---|---|---|
| `active` | boolean | идёт ли захват |
| `fps` | number | |
| `width` | number | ширина кадра в px |
| `frames` | number | сколько кадров отправлено с момента старта |
| `lastFrameAt` | string \| null | ISO-8601 |
| `error` | string \| null | |

### ScreenFrame

| Поле | Тип | Комментарий |
|---|---|---|
| `seq` | number | порядковый номер кадра |
| `ts` | string | ISO-8601 |
| `jpeg` | string | base64 — рисовать как `<img src="data:image/jpeg;base64,{jpeg}">` |

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
| `client.voice` | `VoiceManager` — звонки и голосовые каналы (см. ниже) |
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
| `guildMembers(id, {limit,after})` | `GET /guilds/{guild.id}/members` |
| `guildRoles(id)` | `GET /guilds/{guild.id}/roles` |
| `messages(channelId, {limit,before,after,around})` | `GET /channels/{id}/messages` |
| `message(channelId, messageId)` | `GET /channels/{id}/messages/{id}` |
| `send(channelId, text \| payload)` | `POST /channels/{id}/messages` |
| `edit(channelId, messageId, {content})` | `PATCH /channels/{id}/messages/{id}` |
| `remove(channelId, messageId)` | `DELETE /channels/{id}/messages/{id}` |
| `typing(channelId)` | `POST /channels/{id}/typing` |
| `createDm(userId)` | `POST /users/@me/channels` |
| `pin/unpin/pins(channelId, messageId?)` | пин-эндпоинты |

`send` принимает строку или объект; поле `reply_to` превращается в `message_reference`.

### `client.voice` (VoiceManager)

Голос: звонки и голосовые каналы (подробный разбор — [voice.md](voice.md)).

| Метод / геттер | Что делает |
|---|---|
| `voice.join({channelId, guildId?, selfMute?, selfDeaf?})` | войти в голосовой канал / начать звонок в ЛС (`guildId: null`) → `VoiceConnectionDTO` |
| `voice.leave()` | выйти → `VoiceConnectionDTO` (`phase → idle`) |
| `voice.setState({selfMute?, selfDeaf?})` | включить/выключить мут/деаф → `VoiceConnectionDTO` |
| `voice.setSpeaking(flags)` | битовая маска speaking (1 — голос) |
| `voice.sendPcm(buffer)` | PCM (s16le 48 кГц стерео, кратно 3840 байтам) → число отправленных фреймов |
| `voice.status()` | текущий `VoiceConnectionDTO` |
| `voice.setForwardAudio(bool)` | рассылать ли входящее аудио (`voice-audio`) |
| `voice.channelId` | id текущего канала или `null` |
| `voice.audioForwarding` | включена ли пересылка аудио |

События клиента:

| Событие | `d` |
|---|---|
| `client.on("voice", fn)` | `VoiceConnectionDTO` — каждая смена фазы/участников/speaking (бывает часто) |
| `client.on("voice-dave", fn)` | `VoiceDaveDTO` — состояние E2EE |
| `client.on("voice-speaking", fn)` | `{userId, ssrc, speaking}` |
| `client.on("voice-audio", fn)` | `{userId, pcm}` — `pcm` это `Buffer` (на WS то же событие, но base64) |
| `client.on("debug", fn)` | отладочные сообщения голосового/DAVE-слоя |

`join` без подключённого Gateway бросает `gateway_required`; `setState`/`setSpeaking`/
`sendPcm` без подключения — `not_in_voice`.

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
