# Как сделать UI поверх dsmod (инструкция для ИИ/разработчика)

Задача этого документа — чтобы интерфейс можно было собрать за один проход, не читая
исходники. Всё, что нужно UI, уже описано в [api.md](api.md) и [events.md](events.md).

## 0. Главный принцип

**UI никогда не ходит в Discord напрямую и не знает токен.**

```
┌─────────────┐   HTTP JSON + WS    ┌──────────────┐   REST + Gateway   ┌─────────┐
│  UI (Tauri/ │ ◄─────────────────► │  dsmod bridge │ ◄────────────────► │ Discord │
│  webview)   │  127.0.0.1:8787     │  (Bun)        │                    │         │
└─────────────┘                     └──────────────┘                    └─────────┘
```

Это даёт: нет CORS, нет токена в бандле, один источник правды, UI можно перезапускать
без разлогина.

## 1. Схема экранов

```
        ┌──────────────┐  POST /api/auth/login
        │  Login       │ ──────────────────────┐
        │  email+pass  │                      │
        └──────┬───────┘                      ▼
               │ «QR»               ┌──────────────────┐
               ▼                    │ authenticated?   │──нет──► challenge?
        ┌──────────────┐            └────────┬─────────┘          │
        │  QR screen   │                     │да                  ▼
        │  <img qr>    │             ┌────────▼─────────┐   ┌──────────────┐
        └──────────────┘             │  App             │   │ MFA screen   │
               │  DSMOD_QR           │  chats + thread  │   │ code input   │
               └──► approved ───────►└──────────────────┘   └──────┬───────┘
                                                                   │ POST /api/auth/mfa
                                                                   ▼
                                                              App
```

Состояния входа (`QrStateDTO.status`): `idle → waiting → scanned → approved`
(либо `cancelled` / `expired` / `error`).

## 2. HTTP-клиент (минимум)

```ts
const API = "http://127.0.0.1:8787";

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const payload = await res.json();
  if (!payload.ok) {
    const e = new Error(payload.error.message);
    (e as any).code = payload.error.code;   // unauthorized | discord_401 | …
    throw e;
  }
  return payload.data as T;
}
```

Правила:

- `error.code === "unauthorized"` → показать экран входа (и `POST /api/auth/logout` на всякий).
- `discord_401` → сессия протухла, то же самое.
- всё остальное → тост с `error.message`.

## 3. Первый рендер

```
GET /api/state  →  { me, chats, gateway }
```

Один запрос даёт: кто я, список чатов, жив ли gateway. Дальше — только события.

```ts
const { me, chats, gateway } = await api("/api/state");
```

Если `gateway.connected === false`, но `me` есть — всё равно показывай приложение и
подписывайся на `/events` (переподключение моста обработает само).

## 4. Список чатов

```ts
chats: ChatDTO[]   // уже отсортированы: свежие сверху
```

Что рисовать: `avatarUrl` (или `cdn.discordapp.com/embed/avatars/{defaultAvatarIndex}.png`),
`name`, `kind` (иконка: ЛС / группа / сервер). Ссылку на превью последнего сообщения UI
хранит сам — `lastMessageId` достаточно, чтобы понять порядок.

Логика `MESSAGE_CREATE`:

1. найти чат по `d.channel_id`;
2. поднять его наверх, запомнить `lastMessageId`;
3. если чат открыт — дописать сообщение в ленту.

## 5. Лента сообщений

```
GET /api/channels/{id}/messages?limit=50        → MessageDTO[]  (новые первыми)
```

- Рендер в обратном порядке: `[...messages].reverse()` (как в `examples/ui/index.html`).
- Докрутка вверх → следующая страница:
  `?limit=50&before=${messages[messages.length-1].id}`, склеить массивом.
- Отправка: `POST /api/channels/{id}/messages {content}` → вернёт готовый `MessageDTO`,
  его и добавляем в ленту (оптимистично можно добавить сразу, а id подменить).
- `PATCH /api/messages/{channelId}/{messageId}` → заменить, `DELETE` → убрать.
- «печатает…»: событие `TYPING_START` (`d.user_id !== me.id`), живёт ~8 секунд.

Формат сообщения: `content` может быть пустым — тогда рисуем `attachments` (по `url`)
и `embeds`. Реплай — `referenceMessageId`. Системные сообщения (`type !== 0 && type !== 19`)
лучше показывать тонкой серой строкой.

## 6. Live-события

```ts
function connect() {
  const ws = new WebSocket("ws://127.0.0.1:8787/events");
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 3000);   // авто-reconnect
}
```

Минимальный набор обработчиков: `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`,
`CHANNEL_CREATE/UPDATE/DELETE`, `DSMOD_AUTH`, `DSMOD_QR`, `DSMOD_GATEWAY`.

После каждого переподключения — `GET /api/state` (на случай пропущенных событий).

## 7. Экран входа

| Шаг | Запрос | Ответ |
|---|---|---|
| форма email+пароль | `POST /api/auth/login {email,password}` | `authenticated:true` → в приложение |
| | | `challenge.type:"mfa"` → экран кода |
| | | `error.code:"invalid_credentials"` → подсветить поля |
| код MFA | `POST /api/auth/mfa {ticket, loginInstanceId, method, code}` | `authenticated:true` |
| SMS | `POST /api/auth/sms {ticket}` → `{phone}` | показать «код отправлен на …» |
| QR | `POST /api/auth/qr` → `{url, qrImage}` | рисуем `<img src={qrImage}>` |
| опрос QR | `GET /api/auth/qr` каждые 1.5 c **или** событие `DSMOD_QR` | `scanned` → «подтверди на телефоне», `approved` → в приложение |

Что рисовать в `challenge.type`:

- `mfa` — поле кода; если в `methods` есть `sms`, дать кнопку «получить по SMS»;
- `captcha` — «Discord запросил капчу, повтори позже»;
- `phone` / `email_code` — «подтверди номер/почту» (автоматизации пока нет);
- `locked` — сообщение из `error.message`.

## 8. Структура проекта UI

Рекомендуемая (но не обязательная):

```
ui/
├─ src/
│  ├─ api/client.ts        # обёртка fetch + WS (как в разделе 2 и 6)
│  ├─ api/types.ts         # скопировать из src/types.ts (DTO идентичны)
│  ├─ state/store.ts       # me, chats, открытый канал, messages
│  ├─ screens/Login.tsx    # login + mfa + qr
│  ├─ screens/Chat.tsx     # список чатов + лента + композер
│  └─ components/          # Message, Avatar, TypingIndicator, …
```

Состояние, которое стоит держать в store:

```ts
{
  auth: "loading" | "anonymous" | "mfa" | "qr" | "ready",
  me: UserDTO | null,
  chats: ChatDTO[],
  activeChatId: string | null,
  messagesByChat: Record<string, MessageDTO[]>,
  gateway: "connecting" | "ready" | "reconnecting" | "error",
}
```

Готовый одностраничный ориентир без фреймворков: `examples/ui/index.html`
(открывается на `http://127.0.0.1:8787/`, пока мост запущен).

## 9. Чеклист готовности

- [ ] первый рендер через `GET /api/state`
- [ ] экраны: вход → MFA → QR → приложение
- [ ] список чатов сортируется по `lastMessageId`
- [ ] лента: загрузка, пагинация `before`, отправка, редактирование, удаление
- [ ] `/events` с авто-reconnect + повторный `state` после реконнекта
- [ ] `MESSAGE_CREATE/UPDATE/DELETE` обновляют и ленту, и список чатов
- [ ] ошибки: `unauthorized` → на вход, остальные → тост
- [ ] «печатает…», вложения, реплаи, системные сообщения
- [ ] выход `POST /api/auth/logout`
- [ ] токен нигде не хранится (ни в localStorage, ни в URL)

## 10. Типичные ошибки

1. **Лезть в Discord напрямую из UI** → CORS + утечка токена. Только мост.
2. **Считать `d` событий готовым DTO** → там сырой Discord (`channel_id`, `author`).
   Либо конвертируй, либо используй HTTP-ответы для первоначального рендера.
3. **Не переподключаться после `onclose`** → «мертвый» чат.
4. **Показывать `token` из QR-состояния** → он отдаётся один раз и не нужен UI.
5. **Опрашивать `/api/chats` в цикле** → rate-limit. События уже приходят в WS.

## 11. Звонки и голос

Карточка звонка держится на `VoiceConnectionDTO` и обновляется событием `DSMOD_VOICE`
(шлётся часто — рисуй без лишних перерисовок).

```ts
// войти: guildId не указываем/ null — звонок в ЛС (channelId = id чата)
const call = await api("/api/voice/join", { method: "POST", body: { channelId } });
// звонок в ЛС проще начинать/заканчивать так:
await api(`/api/chats/${dmId}/call`, { method: "POST" });     // начать
await api(`/api/chats/${dmId}/call`, { method: "DELETE" });   // закончить
await api("/api/voice/leave", { method: "POST" });            // выйти из голосового
```

Фазы (`call.phase`):

```
idle → signalling → connecting → ready ⇄ reconnecting → disconnected
```

- `signalling` — отправлен op4; 15 с без ответа → `disconnected` (типичная причина:
  нет прав CONNECT на канал) — покажи ошибку;
- `ready` — всё работает; `reconnecting` — «переподключаемся…» (до 3 попыток);
- `disconnected` — терминальный кик/лимит; после `leave` — снова `idle`.

Что рисовать по `DSMOD_VOICE`:

| Поле | UI |
|---|---|
| `phase` | состояние карточки: вход/подключение/в звонке/переподключение/завершён |
| `participants` | список участников (`userId`, `selfMute`, `selfDeaf`, `deaf`, `mute`) |
| `speaking` | подсветка говорящего (свой флаг тоже здесь) |
| `dave.ready` / `dave.privacyCode` | «сквозное шифрование»; у одного участника `ready:false` и `privacyCode:""` — **это норма** |
| `closeCode` | причина обрыва для сообщения |

Управление:

```ts
await api("/api/voice/state",  { method: "POST", body: { selfMute: true } });   // мут/деаф
await api("/api/voice/speaking", { method: "POST", body: { speaking: true } }); // вручную
```

Слушать/говорить:

- входящее аудио — включить `POST /api/voice/options {forwardAudio:true}` и подписаться
  на `DSMOD_VOICE_AUDIO` (`{userId, pcm}`, base64 PCM 3840 байт = 20 мс) — дальше UI
  сам декодирует/проигрывает (Web Audio);
- отправка — `POST /api/voice/audio {pcm}`: base64 PCM **s16le, 48 кГц, стерео,
  кратно 3840 байтам**; ответ `{sent}` — сколько 20-мс фреймов ушло;
- `speaking` ставится сам (=1 при отправке аудио, снимается через 4 с покоя);
  `DSMOD_VOICE_SPEAKING` — для индикатора «говорит» у собеседников;
- `DSMOD_VOICE_DAVE` — смена состояния E2EE, `DSMOD_DEBUG` — в консоль для отладки.

Ошибки: `gateway_required` (gateway не подключён — жди `DSMOD_GATEWAY: ready`),
`not_in_voice` (действие вне подключения), `conflict` (звонок идёт в другом канале).

## 12. Демонстрация экрана

Локальный захват экрана → JPEG-кадры в WS. Один фоновый процесс PowerShell, без
внешних зависимостей; работает на Windows.

```ts
await api("/api/screen/start", { method: "POST", body: { fps: 2, width: 1280 } });
// fps 1..10 (по умолчанию 2), width 320..1920 px (по умолчанию 1280)
// повторный start — перезапуск с новыми параметрами
await api("/api/screen/stop", { method: "POST" });
const status = await api("/api/screen");   // ScreenStatus: active, fps, width, frames, …
```

Кадры — событие `DSMOD_SCREEN_FRAME`: `{seq, ts, jpeg}` (base64). Рисовать:

```ts
if (t === "DSMOD_SCREEN_FRAME") preview.src = `data:image/jpeg;base64,${d.jpeg}`;
```

`DSMOD_SCREEN_STATUS` — запуск/остановка/ошибка (`status.error`) — обновляй тумблер и
счётчик `frames`. Это источник кадров для UI (превью/футаж); сам Go Live-видеопоток в
Discord пока не формируется — см. [voice.md](voice.md), раздел «Статус и дорожная карта».
