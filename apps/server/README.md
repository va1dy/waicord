# waicord server

Self-hosted сервер waicord: аккаунты, каналы, сообщения (REST + WebSocket).
Ноль зависимостей — только Bun и SQLite.

## Запуск локально

```bash
bun install   # опционально, зависимостей нет
bun run dev   # разработка (авто-reload)
bun run start # продакшен
```

Сервер слушает `0.0.0.0:8080`. База — `data.db` рядом со скриптом.

Переменные окружения:

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `PORT` | `8080` | порт |
| `DB_PATH` | `./data.db` | путь к SQLite |

## Деплой на Linux (VPS)

1. Установи Bun: `curl -fsSL https://bun.sh/install | bash`
2. Скопируй папку `apps/server` на сервер, например в `/opt/waicord-server`
3. Создай юнит `/etc/systemd/system/waicord.service`:

```ini
[Unit]
Description=waicord server
After=network.target

[Service]
WorkingDirectory=/opt/waicord-server
ExecStart=/root/.bun/bin/bun src/index.ts
Restart=on-failure
Environment=PORT=8080
Environment=DB_PATH=/opt/waicord-server/data.db

[Install]
WantedBy=multi-user.target
```

4. Включи и запусти:

```bash
systemctl daemon-reload
systemctl enable --now waicord
```

5. Открой порт: `ufw allow 8080/tcp` (или Security Group у провайдера).

Клиент подключается по адресу `http://IP_СЕРВЕРА:8080`.

## API

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/api/health` | проверка доступности |
| POST | `/api/register` | `{username, email, password}` → `{token, user}` |
| POST | `/api/login` | `{identifier, password}` → `{token, user}` |
| GET | `/api/me` | профиль (Bearer) |
| GET | `/api/channels` | список каналов (Bearer) |
| POST | `/api/channels` | `{name}` — создать канал (Bearer) |
| GET | `/api/channels/:id/messages` | история (Bearer, `?limit=`) |
| POST | `/api/channels/:id/messages` | `{content}` — отправить (Bearer) |
| WS | `/ws?token=` | live-события `{type:"message", message}` |
