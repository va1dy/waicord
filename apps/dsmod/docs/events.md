# События (Gateway)

Мост открывает один Gateway-коннект к Discord и транслирует события всем UI
по WebSocket `ws://127.0.0.1:8787/events`.

## Формат кадра

```json
{ "t": "MESSAGE_CREATE", "d": { ... }, "s": 128, "ts": "2026-10-12T16:41:49.010Z" }
```

| Поле | Значение |
|---|---|
| `t` | имя события |
| `d` | данные (**сырые** объекты Discord, не DTO) |
| `s` | номер события в сессии (для resume) |
| `ts` | когда мост его получил |

> В `d` лежат объекты Discord как есть: `d.channel_id`, `d.author.username`,
> `d.content`. Схемы — [discord-api-docs / Gateway Events](https://discord.com/developers/docs/events/gateway-events).
> Конвертация в DTO есть только в HTTP-ответах.

## Служебные события моста

| `t` | `d` | Когда |
|---|---|---|
| `DSMOD_HELLO` | `{version:1}` | клиент подключился |
| `DSMOD_PONG` | `{}` | ответ на `ping` |
| `DSMOD_AUTH` | `{authenticated, me}` | вошли/вышли (обнови экран) |
| `DSMOD_QR` | `QrStateDTO` | изменился статус QR-входа |
| `DSMOD_GATEWAY` | `{status, error?}` | gateway переподключился / упал |

`status`: `connecting → ready → (reconnecting) → ready | closed`.

## События, на которые стоит подписаться в чате

| `t` | Что делать в UI |
|---|---|
| `MESSAGE_CREATE` | если `d.channel_id` открыт — дописать сообщение в ленту; в любом случае поднять чат наверх списка и обновить превью |
| `MESSAGE_UPDATE` | заменить сообщение с `d.id` (в `d` может быть только часть полей — склей с кешем) |
| `MESSAGE_DELETE` | убрать `d.id` из ленты |
| `CHANNEL_CREATE` / `CHANNEL_UPDATE` | добавить/обновить элемент в списке чатов |
| `CHANNEL_DELETE` | убрать чат из списка |
| `TYPING_START` | показать «печатает…» (`d.user_id` ≠ свой id) |
| `GUILD_CREATE` | новый сервер → обновить список |
| `RELATIONSHIP_ADD` / `RELATIONSHIP_REMOVE` | новая/удалённая связь (друзья) |
| `PRESENCE_UPDATE` | онлайн-статус собеседника |
| `READY` | сессия готова: `d.session_id`, `d.resume_gateway_url`, `d.user` |

Полный список — [Gateway Events](https://discord.com/developers/docs/events/gateway-events).

## Пример

```ts
const ws = new WebSocket("ws://127.0.0.1:8787/events");

ws.onmessage = (event) => {
  const { t, d } = JSON.parse(event.data);

  switch (t) {
    case "MESSAGE_CREATE":
      if (d.channel_id === currentChannelId) appendMessage(d);
      touchChat(d.channel_id, d);
      break;
    case "DSMOD_AUTH":
      if (!d.authenticated) showLoginScreen();
      break;
    case "DSMOD_QR":
      renderQr(d);
      break;
  }
};

ws.onclose = () => setTimeout(connect, 3000);   // мост мог перезапуститься
```

## Надёжность

- Gateway переподключается сам (backoff до 30 c) и делает `resume`, если сессия жива.
- UI обязан переподключаться к `/events` после обрыва — вкладка/окно могло проспать.
- После переподключения сделай `GET /api/state` — так ты точно синхронизируешься.
- События можно пропустить (обрыв) — поэтому state всё равно подтягивай, а не только события.

## Ограничения

User-сессии не требуют `intents` — приходят все события, включая присутствия и
участников. Тем не менее Discord может отдавать `MESSAGE_CREATE` без `content`
(если аккаунт не включал `MESSAGE_CONTENT` для ботов) — это касается ботов, на
user-сессии контент приходит.
