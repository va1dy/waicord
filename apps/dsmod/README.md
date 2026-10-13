# dsmod

Базовый **клиентский API для Discord-мода**: вход в аккаунт (пароль / MFA / QR),
чак-список, сообщения, живые события Gateway — и локальный HTTP-мост, на который
можно построить любой интерфейс (веб, Tauri-десктоп) за один вечер.

> ⚠️ Работает от имени **пользовательского** аккаунта (user token), а не бота.
> Это нарушает Discord ToS и может привести к блокировке аккаунта. Используй осознанно.

## Что умеет сейчас

| Область | Статус |
|---|---|
| Вход по почте + паролю, MFA (TOTP/SMS) | ✅ |
| Вход по QR-коду (как в официальном клиенте) | ✅ |
| Список чатов (ЛС, групповые, каналы серверов) | ✅ |
| Чтение / отправка / редактирование / удаление сообщений | ✅ |
| Пагинация (`before/after/around`), «печатает…», закрепы | ✅ |
| Серверы и их каналы | ✅ |
| Участники и роли серверов | ✅ |
| Голосовые каналы и звонки в ЛС (join/leave/mute/speaking, аудио в обе стороны, E2EE DAVE) | ✅ |
| Демонстрация экрана (захват кадров → WS) | ✅ |
| Gateway: `MESSAGE_CREATE/UPDATE/DELETE`, typing, presence… | ✅ |
| Rate-limit aware REST-клиент | ✅ |
| Локальный HTTP + WebSocket мост для UI | ✅ |
| Демо-интерфейс (без сборки) | ✅ |
| Standalone `.exe` (`bun run build:exe`, UI вшит внутрь) | ✅ |
| Десктоп-упаковка (Tauri sidecar) | 📄 [docs/tauri.md](docs/tauri.md) |
| Загрузка вложений, поиск, реакции, звук | 🗓 |

## Структура

```
dsmod/
├─ src/
│  ├─ index.ts            # публичный экспорт SDK
│  ├─ client.ts           # DscClient — фасад: auth + rest + gateway
│  ├─ resources.ts        # чаты, сообщения, серверы, пользователи
│  ├─ gateway.ts          # WebSocket Gateway (heartbeat/resume/reconnect)
│  ├─ dto.ts              # Discord-объекты → плоские DTO для UI
│  ├─ types.ts            # DTO и типы (общие для SDK и UI)
│  ├─ errors.ts           # дерево ошибок
│  ├─ config.ts           # заголовки, свойства клиента, пути
│  ├─ qr-image.ts         # QR → data-uri картинка
│  ├─ http/client.ts      # REST v9 + rate limits
│  ├─ auth/               # password / MFA / QR remote-auth / сессия
│  └─ server/             # локальный HTTP+WS мост (Bun.serve)
├─ examples/
│  ├─ cli.ts              # консольный клиент
│  └─ ui/index.html       # демо-интерфейс без сборки
├─ scripts/smoke.ts       # быстрая проверка моста
└─ docs/                  # документация
```

## Быстрый старт

```bash
bun install
bun start                 # мост на http://127.0.0.1:8787
```

Открой `http://127.0.0.1:8787/` — демо-UI с экранами входа (пароль/MFA/QR) и чатами.

### Один файл вместо всего окружения (.exe)

```bash
bun run build:exe         # → dist/dsmod-bridge.exe (~92 МБ, Windows x64)
dist\dsmod-bridge.exe --port 8787
```

В бинарник вшит рантайм Bun и демо-интерфейс: запускать можно на машине без Bun и
без node_modules. Кросс-компиляция под macOS/Linux: `bun build --compile --target=<триплет> …`
(см. [docs/tauri.md](docs/tauri.md)).

Или из консоли:

```bash
bun run examples/cli.ts login you@mail.com     # вход, MFA
bun run examples/cli.ts chats                  # список чатов
bun run examples/cli.ts send <channelId> "привет"
bun run examples/cli.ts qr                     # вход по QR
```

Или сразу из кода:

```ts
import { createClient } from "./src/index";

const client = await createClient();
await client.login({ email, password });

const chats = await client.api.chats();
await client.api.send(chats[0].id, "привет");

client.on("MESSAGE_CREATE", (m) => console.log(m.author.username, m.content));
await client.connect();
```

## Документация

| Документ | О чём |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | запуск, первые запросы |
| [docs/api.md](docs/api.md) | все endpoint'ы, DTO, методы SDK |
| [docs/auth.md](docs/auth.md) | вход: пароль, MFA, QR, хранение токена |
| [docs/events.md](docs/events.md) | события Gateway и формат кадров |
| [docs/ui.md](docs/ui.md) | **как собрать интерфейс поверх моста** |
| [docs/tauri.md](docs/tauri.md) | десктопное приложение |
| [docs/discord-reference.md](docs/discord-reference.md) | соответствие официальным discord-api-docs |

## Как это устроено

```
UI (web / Tauri)  ──HTTP+WS──►  dsmod bridge (127.0.0.1:8787)  ──REST+Gateway──►  Discord
```

- **UI не знает токен** — он живёт в мосте (`~/.dsmod/session.json`).
- **Нет CORS** — мост отдаёт `Access-Control-Allow-Origin: *` и слушает только loopback.
- **Один формат данных** — одни и те же DTO в SDK и в HTTP-ответах.
- **Live** — всё, что приходит из Gateway, тут же уходит в `/events`.

## Разработка

```bash
bun run typecheck     # строгий TS, без emit
bun run scripts/smoke.ts   # мост должен быть запущен
```

Правила совместной работы — в [AGENTS.md](AGENTS.md).
