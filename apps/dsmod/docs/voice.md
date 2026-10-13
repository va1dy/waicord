# Голос: звонки, каналы, DAVE, экран

Технический разбор голосовой подсистемы dsmod. Контракт для UI — в [api.md](api.md)
(эндпоинты `/api/voice*`, `/api/screen*`, DTO) и [events.md](events.md)
(`DSMOD_VOICE*`, `DSMOD_SCREEN_*`).

## 1. Обзор

Голосовая подсистема умеет:

- **голосовые каналы серверов** — `POST /api/voice/join {channelId, guildId}`;
- **звонки в ЛС** — `POST /api/chats/{id}/call` (тот же конвейер, `guild_id = null`);
- **аудио в обе стороны** — входящий PCM/Opus из канала и исходящий PCM от UI;
- **E2EE через DAVE** — обязательно у Discord с 03.2026, версия 1;
- **mute / deaf / speaking** — вручную и автоматически;
- **участники канала** — собираются из `VOICE_STATE_UPDATE` и стартовых
  `voice_states` из `READY`;
- **захват экрана** — кадры для UI (см. раздел 5).

Код: `src/voice/` (`manager` — фазы и DTO, `connection` — voice WS + UDP,
`dave` — E2EE, `rtp`/`opus` — пакеты), `src/server/screen.ts` — захват.

## 2. Диаграмма подключения

```
 UI/SDK              Gateway (внутр. мост)           Voice-сервер
   │ POST /api/voice/join                             │
   │────────► op4 Voice State Update {guild_id,       │
   │          channel_id, self_mute, self_deaf}       │
   │                   │  VOICE_STATE_UPDATE (session_id)   │
   │                   │  VOICE_SERVER_UPDATE (token, endpoint)
   │                   │◄─────────────────────────────│ (события Gateway)
   │                   │                             │
   │        voice WS: wss://<endpoint>?v=8           │
   │                   │──── op0 Identify            │
   │                   │  {server_id, user_id, session_id, token,
   │                   │   max_dave_protocol_version: 1}    │
   │                   │◄─── op2 Ready {ssrc, ip, port, modes}
   │                   │                             │
   │        UDP IP-discovery: 74 байта               │
   │                   │──── type 0x01, length 70, ssrc ───►│
   │                   │◄─── type 0x02 + адрес + порт ─────│
   │                   │                             │
   │                   │──── op1 Select Protocol     │
   │                   │  {protocol: "udp",          │
   │                   │   data: {address, port, mode}}     │
   │                   │◄─── op4 Session Description │
   │                   │  {mode, secret_key[32],     │
   │                   │   dave_protocol_version}    │
   │ phase: ready ◄────│                             │
```

Остальное на голосовом WS:

| op | Направление | Что |
|---|---|---|
| `3` / `6` | клиент → / ← сервер | heartbeat `{t, seq_ack}` / ack |
| `8` | ← сервер | hello — интервал heartbeat |
| `5` | клиент ↔ сервер | speaking `{speaking, delay, ssrc}` (и входящие: связка `ssrc ↔ user_id`) |
| `7` / `9` | клиент → / ← сервер | resume / resumed (после обрыва) |
| `11` | ← сервер | `user_ids` — участники для DAVE |
| `13` | ← сервер | участник отключился |

Фазы (`VoiceConnectionDTO.phase`):

| Фаза | Что происходит |
|---|---|
| `idle` | не в голосе |
| `signalling` | отправлен op4; **таймаут 15 с** без ответа → `disconnected` (типичная причина: нет прав CONNECT на канал) |
| `connecting` | ждём `VOICE_STATE_UPDATE` + `VOICE_SERVER_UPDATE` от Gateway, идёт WS/UDP-хендшейк |
| `ready` | voice WS v8 + UDP + DAVE — идёт аудио |
| `reconnecting` | до 3 попыток, экспоненциальная задержка |
| `disconnected` | терминальные коды `4014`/`4021`/`4022` или лимит попыток; после `leave` → `idle` |

## 3. DAVE (E2EE)

DAVE — сквозное шифрование звонков, **обязательно у Discord с 03.2026**.

- версия **1** согласуется автоматически (`max_dave_protocol_version` в op0 Identify);
- key package (опкод 26) уходит в момент Session Description (опкод 4);
- `privacyCode` заполняется, когда в звонке **≥2 участников** (собрана MLS-группа);
  у одного участника `ready: false`, `privacyCode: ""` — это норма;
- состояние приходит событием `DSMOD_VOICE_DAVE` / `client.on("voice-dave")`.

### Опкоды 21–31

Бинарные: **входящие** `[seq u16 BE][opcode u8][payload]`, **исходящие**
`[opcode u8][payload]`.

| Opcode | Название | Смысл |
|---|---|---|
| 21 | prepare transition | сервер готовит переход протокола; клиент отвечает 23 |
| 22 | execute transition | применить подготовленный переход |
| 23 | transition ready | подтверждение перехода (клиент → сервер) |
| 24 | prepare epoch | новая MLS-эпоха (epoch 1 = первая ключевая группа) |
| 25 | external sender | внешний отправитель — сервер подписывает commit'ы |
| 26 | key package | наш key package (клиент → сервер) |
| 27 | proposals | proposal'ы от сервера → отвечаем 28 |
| 28 | commit + welcome | наш commit/welcome (клиент → сервер) |
| 29 | announce commit | сервер объявил commit → применяем, подтверждаем 23 |
| 30 | welcome | нас добавили в группу |
| 31 | invalid commit | невалидный commit/welcome → переинициализация группы |

Тяжёлую криптографию (OpenMLS) делает **`@snazzah/davey`** — та же библиотека, что в
`@discordjs/voice`; наш код (`src/voice/dave.ts`) — диспетчеризация опкодов по схеме из
официального примера `discord/libdave/samples/typescript`.

## 4. RTP и аудио

Конвейер отправки: **PCM → opus (20 мс фреймы) → DAVE → RTP**.
Входящие: **RTP → транспортная расшифровка → DAVE decrypt → opus decode →
`DSMOD_VOICE_AUDIO`** (только при включённом `forwardAudio`).

- входящий пакет фильтруется по payload type **`0x78`**;
- частота **48 кГц**, стерео, фрейм **960 сэмплов** (20 мс = 3840 байт PCM);
- транспортное шифрование UDP — `aead_aes256_gcm_rtpsize` (выбирается, если его
  предлагает сервер), иначе `aead_xchacha20_poly1305_rtpsize`;
- nonce = `[u32 BE counter][нули]`, тот же счётчик дописывается в хвост пакета,
  AAD = незашифрованный RTP-хедер;
- Opus-кодек — `opusscript` (libopus в WASM).

Событие `speaking`: выставляется **автоматически = 1** при отправке аудио и снимается
через **4 с** без аудио; можно управлять вручную (`POST /api/voice/speaking`,
`client.voice.setSpeaking(flags)` — битовая маска, 1 — голос).

## 5. Демонстрация экрана

Локальный захват: **один фоновый процесс PowerShell** (`System.Drawing`, без внешних
зависимостей, Windows-only). Он каждый кадр снимает основной экран, масштабирует до
`width`, кодирует в **JPEG (quality ~60)**, пишет base64-строкой в stdout — мост
парсит строки и рассылает подписчикам.

- параметры: `fps` 1..10 (по умолчанию 2), `width` 320..1920 px (по умолчанию 1280);
  повторный `POST /api/screen/start` — перезапуск с новыми параметрами;
- кадр — `ScreenFrame {seq, ts, jpeg}`; рисовать как
  `<img src="data:image/jpeg;base64,{jpeg}">`;
- статус — `ScreenStatus {active, fps, width, frames, lastFrameAt, error}`,
  события `DSMOD_SCREEN_STATUS` / `DSMOD_SCREEN_FRAME`.

Это **источник кадров для UI** (превью/футаж), а не видео-стрим Discord.

## 6. Статус и дорожная карта

**Сделано:**

- сигналинг: `join` / `leave` / `state` / `speaking`, звонки в ЛС;
- аудио в обе стороны (Opus/RTP, 20 мс фреймы);
- E2EE DAVE версии 1 (автосогласование, key package, MLS-группа, privacyCode);
- участники, speaking, фазы и DAVE-состояние наружу через DTO/события;
- захват кадров экрана → WS (`/api/screen`, `DSMOD_SCREEN_FRAME`).

**Не сделано (честно):**

- **сам Go Live-видеопоток в Discord пока не формируется** — нет H.264 RTP/видео,
  нет `STREAM_*`-подписок (`STREAM_CREATE` и т.п.), нет просмотра чужих стримов;
- захват экрана — только локальные кадры для UI, в Discord видео не уходит.

Референс протокола видео — [Discord-RE/Discord-video-stream](https://github.com/Discord-RE/Discord-video-stream)
(лицензия ISC). Спецификации и ссылки — [discord-reference.md](discord-reference.md).
