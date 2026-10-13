# Соответствие discord-api-docs

Источник истины: репозиторий [discord/discord-api-docs](https://github.com/discord/discord-api-docs)
(он же https://discord.com/developers/docs). Таблица «что из чего взято» — чтобы при
расширении API не гадать, а открывать конкретный раздел.

## Официально документированные endpoint'ы

| Наш код | Метод и путь | Раздел docs |
|---|---|---|
| `resources.me()` | `GET /users/@me` | [User → Get Current User](https://discord.com/developers/docs/resources/user#get-current-user) |
| `resources.user(id)` | `GET /users/{user.id}` | [User → Get User](https://discord.com/developers/docs/resources/user#get-user) |
| `resources.createDm(id)` | `POST /users/@me/channels` | [User → Create DM](https://discord.com/developers/docs/resources/user#create-dm) |
| `resources.guilds()` | `GET /users/@me/guilds` | [Guild → Get Current User Guilds](https://discord.com/developers/docs/resources/guild#get-current-user-guilds) |
| `resources.guild(id)` | `GET /guilds/{guild.id}` | [Guild → Get Guild](https://discord.com/developers/docs/resources/guild#get-guild) |
| `resources.guildChats(id)` | `GET /guilds/{guild.id}/channels` | [Guild → Get Guild Channels](https://discord.com/developers/docs/resources/guild#get-guild-channels) |
| `resources.chat(id)` | `GET /channels/{channel.id}` | [Channel → Get Channel](https://discord.com/developers/docs/resources/channel#get-channel) |
| `resources.messages()` | `GET /channels/{channel.id}/messages` | [Message → Get Channel Messages](https://discord.com/developers/docs/resources/message#get-channel-messages) |
| `resources.message()` | `GET /channels/{channel.id}/messages/{message.id}` | [Message → Get Channel Message](https://discord.com/developers/docs/resources/message#get-channel-message) |
| `resources.send()` | `POST /channels/{channel.id}/messages` | [Message → Create Message](https://discord.com/developers/docs/resources/message#create-message) |
| `resources.edit()` | `PATCH /channels/{channel.id}/messages/{message.id}` | [Message → Edit Message](https://discord.com/developers/docs/resources/message#edit-message) |
| `resources.remove()` | `DELETE /channels/{channel.id}/messages/{message.id}` | [Message → Delete Message](https://discord.com/developers/docs/resources/message#delete-message) |
| `resources.typing()` | `POST /channels/{channel.id}/typing` | [Channel → Trigger Typing Indicator](https://discord.com/developers/docs/resources/channel#trigger-typing-indicator) |
| `resources.pin/unpin/pins` | `…/messages/pins/…` | [Message → Pin Message / Get Channel Pins](https://discord.com/developers/docs/resources/message#pin-message) |
| `gateway.ts` | `wss://gateway.discord.gg/?v=9&encoding=json` | [Gateway → Connecting](https://discord.com/developers/docs/events/gateway#connecting) |
| `gateway.sendIdentify()` | op `2` Identify | [Gateway Events → Identify](https://discord.com/developers/docs/events/gateway-events#identify) |
| `gateway.sendResume()` | op `6` Resume | [Gateway Events → Resume](https://discord.com/developers/docs/events/gateway-events#resume) |
| `gateway` heartbeat | op `1` / `11` | [Gateway → Sending Heartbeats](https://discord.com/developers/docs/events/gateway#sending-heartbeats) |
| `toUser/toChat/toMessage/toGuild` | объекты User / Channel / Message / Guild | [Resources](https://discord.com/developers/docs/resources/) |

## Не документированные (закрытые) endpoint'ы

Discord не публикует их в docs — значения взяты из открытых реализаций клиентов
(endcord, discord.js-selfbot-v13, discord.py-self) и проверены вживую.

| Что | Путь | Статус в dsmod |
|---|---|---|
| Вход по паролю | `POST /auth/login` | ✅ |
| MFA | `POST /auth/mfa/{totp,sms}`, `POST /auth/mfa/sms/send` | ✅ |
| Подтверждение телефона | `POST /phone-verifications/verify` | ✅ в SDK, ❌ не выведен в мост |
| Обмен ticket → токен (QR) | `POST /users/@me/remote-auth/login` | ✅ |
| QR-шлюз | `wss://remote-auth-gateway.discord.gg/?v=2` | ✅ |
| Личные переписки | `GET /users/@me/channels` | ✅ (используется официальным веб-клиентом, но выведен из публичных docs) |

## Политика безопасности заголовков

Чтобы API не отбрасывал запросы, клиент шлёт те же заголовки, что и настоящий клиент:

```
User-Agent: Mozilla/5.0 … discord/1.0.156 Chrome/… Safari/…      ← src/config.ts
X-Super-Properties: base64(JSON свойств клиента)
X-Discord-Locale: en-US
Accept-Language, Accept, Content-Type
Authorization: <user token>
```

`X-Super-Properties` декодируется сервером и должен содержать `os`, `browser`,
`release_channel`, `client_version`, `client_build_number` — это видно в
[Gateway Identify → properties](https://discord.com/developers/docs/events/gateway-events#identify-identify-structure).

## Версия API

Используется `v9` — так же, как современные user-клиенты (`discord.py-self` держит
`INTERNAL_API_VERSION = 9`). Официальные docs сейчас описывают `v10`; переключение —
один параметр: `new DscClient({ apiVersion: 10 })`.

## Что добавить дальше

- `GET /channels/{id}` для тредов/форумов (сейчас возвращается как есть, но UI не различает треды)
- `GET /guilds/{id}/messages/search` — поиск по серверу ([Search Guild Messages](https://discord.com/developers/docs/resources/message#search-guild-messages))
- реакции: `PUT …/reactions/{emoji}/@me` ([Create Reaction](https://discord.com/developers/docs/resources/message#create-reaction))
- `GET /users/{id}/profile` — профиль пользователя (закрытый)
