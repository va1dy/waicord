# waicord server

Self-hosted сервер waicord: аккаунты, каналы, друзья, ЛС и группы, сообщения (REST + WebSocket).
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
| PATCH | `/api/me` | `{display_name?, status?, bio?, avatar_url?}` — обновить профиль (Bearer) |
| POST | `/api/upload` | `{name, data(base64)}` → `{url}` — файл, ≤10 МБ (Bearer) |
| GET | `/uploads/:file` | отдать загруженный файл |
| GET | `/api/channels` | список каналов (Bearer) |
| POST | `/api/channels` | `{name}` — создать канал (Bearer) |
| GET | `/api/channels/:id/messages` | история (Bearer, `?limit=`) |
| POST | `/api/channels/:id/messages` | `{content?, attachments?[]}` — отправить (Bearer) |
| GET | `/api/friends` | друзья + заявки (Bearer) |
| POST | `/api/friends/requests` | `{username}` — отправить заявку (Bearer) |
| POST | `/api/friends/requests/:id/accept` | принять заявку (Bearer) |
| POST | `/api/friends/requests/:id/decline` | отклонить/отменить (Bearer) |
| DELETE | `/api/friends/:userId` | удалить из друзей (Bearer) |
| GET | `/api/dms` | список ЛС и групп (Bearer) |
| POST | `/api/dms` | `{usernames[], name?, kind?}` — ЛС/группа (Bearer) |
| GET | `/api/dms/:id/messages` | история ЛС (Bearer, `?limit=`) |
| POST | `/api/dms/:id/messages` | `{content?, attachments?[]}` — отправить в ЛС (Bearer) |
| WS | `/ws?token=` | live-события (см. ниже) |

### WebSocket-события

Входящие (от клиента):
- `{type:"message", channel_id, content?, attachments?[]}`
- `{type:"dm", conversation_id, content?, attachments?[]}`
- `{type:"signal", to, payload}` — сигналинг звонков WebRTC (relay, только общий диалог)

Исходящие (broadcast):

| type | payload | когда |
| --- | --- | --- |
| `message` | `{message}` | новое сообщение в канале (всем) |
| `dm` | `{message}` | новое ЛС/групповое сообщение (участникам) |
| `friend_request` | `{from}` | заявка в друзья (получателю) |
| `friend_accept` | `{from}` | заявка принята (отправителю) |
| `friend_remove` | `{from}` | удаление из друзей |
| `dm_create` | `{conversation}` | создана группа с тобой |
| `channel_create` | `{channel}` | создан канал (всем) |
| `presence` | `{user_id, online}` | друг вышел/зашёл (друзьям) |
| `profile_updated` | `{user}` | профиль обновлён (тебе) |
| `signal` | `{from, payload}` | звонок WebRTC (получателю) |

Presence хранится в памяти процесса (сбрасывается при рестарте).
