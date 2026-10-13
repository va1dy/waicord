# Быстрый старт

Все команды выполняются в корне репозитория. Нужен [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install
```

## 1. Поднять локальный мост

```bash
bun start                      # http://127.0.0.1:8787
# или
bun run dev                    # с перезапуском при изменении файлов
bun run src/server/main.ts --port 9000 --no-gateway
```

Мост — это весь «бэкенд» мода: HTTP JSON + WebSocket событий. UI ходит только в него,
токен Discord во фронтенд не уходит.

Если ставить Bun/Node негде — собери один исполняемый файл (в него вшит демо-UI):

```bash
bun run build:exe         # → dist/dsmod-bridge.exe
dist\dsmod-bridge.exe
```

Проверка:

```bash
curl http://127.0.0.1:8787/api/health
bun run scripts/smoke.ts       # прогон основных маршрутов
```

Открой `http://127.0.0.1:8787/` — там лежит демо-интерфейс (`examples/ui/index.html`).

## 2. Войти

Три равных способа (любой из них сохраняет сессию в `~/.dsmod/session.json`):

| Способ | Где |
|---|---|
| Почта + пароль (+код MFA) | UI «Вход в Discord» или `bun run examples/cli.ts login you@mail.com` |
| QR-код (как в официальном клиенте) | UI «Войти по QR-коду» или `bun run examples/cli.ts qr` |
| Готовый токен | `POST /api/auth/token {"token":"..."}` или `DSMOD_TOKEN` в `.env` |

Подробности и что делать с challenge'ами — [docs/auth.md](auth.md).

## 3. Первые запросы

```bash
# кто я
curl http://127.0.0.1:8787/api/me

# список чатов (ЛС + групповые + каналы серверов)
curl http://127.0.0.1:8787/api/chats

# 50 последних сообщений в канале
curl "http://127.0.0.1:8787/api/channels/CHANNEL_ID/messages?limit=50"

# отправить
curl -X POST http://127.0.0.1:8787/api/channels/CHANNEL_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"content":"привет из dsmod"}'
```

## 4. Живые события

```js
const ws = new WebSocket("ws://127.0.0.1:8787/events");
ws.onmessage = (e) => {
  const { t, d } = JSON.parse(e.data);
  if (t === "MESSAGE_CREATE") console.log(d.author.username, d.content);
};
```

Список событий — [docs/events.md](events.md).

## 5. То же самое, но из TypeScript (SDK)

```ts
import { createClient } from "./src/index";

const client = await createClient();          // подхватывает сохранённую сессию
if (!client.isAuthenticated) {
  const result = await client.login({ email, password });
  if (!result.ok && result.challenge?.type === "mfa") {
    await client.solveMfa(result.challenge, { code: "123456", method: "totp" });
  }
}

await client.connect();                       // gateway: события в реальном времени
client.on("MESSAGE_CREATE", (m) => console.log(m.author.username, m.content));

const chats = await client.api.chats();
await client.api.send(chats[0].id, "привет");
```

## Дальше

- [docs/api.md](api.md) — все endpoint'ы, DTO и методы SDK
- [docs/auth.md](auth.md) — вход, MFA, QR, хранение токена
- [docs/events.md](events.md) — события Gateway
- [docs/ui.md](ui.md) — как построить интерфейс поверх моста (инструкция для ИИ)
- [docs/tauri.md](tauri.md) — подключение десктопного приложения
- [docs/discord-reference.md](discord-reference.md) — соответствие официальным discord-api-docs
