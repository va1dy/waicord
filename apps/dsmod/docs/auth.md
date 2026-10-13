# Вход в аккаунт

> ⚠️ **Дисклеймер.** Этот код работает от имени *пользовательского* аккаунта (user token),
> а не бота. Автоматизация user-аккаунта нарушает [Discord ToS](https://discord.com/terms)
> и может привести к блокировке. Используй на свой риск и не для спама.

Все три способа приводят к одному результату — токену, который сохраняется в
`~/.dsmod/session.json` (файл в `.gitignore`, правa `0600` на POSIX).

```
login(email, password) ──┬─→ токен ─────────────────────────────→ сессия
                         └─→ challenge {type:"mfa"} → код ──────→ токен
QR ─→ fingerprint → QR отсканован → подтверждено на телефоне ────→ токен
токен из .env / UI ─────────────────────────────────────────────→ сессия
```

## 1. Почта + пароль

`POST /auth/login` с `{ login, password }`. Ответ бывает трёх видов:

| Ответ Discord | Что делает API |
|---|---|
| `{ token }` | `AuthResult { ok:true, token }` — вход завершён |
| `{ ticket, totp, sms, webauthn, login_instance_id }` | `AuthResult { ok:false, challenge:{type:"mfa", methods, ticket, loginInstanceId} }` |
| 400 с ошибкой | мапится в `AuthResult { ok:false, error:{code,...} }` |

Коды ошибок, которые превращаются в осмысленные ответы для UI:

| Discord code | `error.code` | Что показать |
|---|---|---|
| 50035 / 401 | `invalid_credentials` | «Неверная почта или пароль» |
| 20011 / 20013 | `account_disabled` | «Аккаунт заблокирован» |
| 70007 | `phone_verification_required` (+ `challenge.type="phone"`) | «Подтверди номер телефона» |
| 70009 | `email_verification_required` (+ `challenge.type="email_code"`) | «Введи код с почты» |
| `captcha_key` в теле | `captcha_required` (+ `challenge.type="captcha"`) | «Discord запросил капчу» |

> Шаги `phone` и `email_code` возвращаются как challenge, но автоматически пока не
> закрываются (см. [План](#план)). MFA закрывается полностью.

### MFA

```
POST /api/auth/mfa  {"ticket":"...","loginInstanceId":"...","method":"totp|sms","code":"123456"}
```

Внутри: `POST /auth/mfa/{totp|sms}` с `{ code, login_instance_id, ticket }` → `{ token }`.

Для SMS сначала `POST /api/auth/sms {"ticket":"..."}` → `POST /auth/mfa/sms/send`,
Discord вернёт маскированный номер.

### Капча

Капча **не** решается автоматически (нужен `captcha_sitekey` + сторонний сервис или ручной
ввод). В API она приходит как `challenge.type="captcha"` — UI может попросить повторить
вход позже. Практика показывает, что капча чаще всего прилетает при подозрительном IP/User-Agent.

## 2. QR-код (remote auth)

Полностью повторяет официальный клиент — шлюз `wss://remote-auth-gateway.discord.gg/?v=2`:

1. клиент подключается и получает `hello` (`heartbeat_interval`, `timeout_ms`);
2. генерирует RSA-2048 ключ pair и шлёт `init` с `encoded_public_key` (base64 SPKI);
3. сервер отвечает `pending_remote_init` с `fingerprint` → **это и есть QR**:
   `https://discord.com/ra/<fingerprint>`;
4. на `nonce_proof` клиент расшифровывает `encrypted_nonce` (RSA-OAEP-SHA256),
   считает `sha256(nonce)` → base64url и отправляет `proof`;
5. `pending_ticket` → пользователь отсканировал (в payload id и username);
6. `pending_login` → `POST /users/@me/remote-auth/login { ticket }` → `encrypted_token`
   → расшифровка приватным ключом → токен.

Через мост:

```bash
curl -X POST http://127.0.0.1:8787/api/auth/qr
# → { "url": "https://discord.com/ra/xxxx", "qrImage": "data:image/svg+xml;base64,...", "state": {...} }

curl http://127.0.0.1:8787/api/auth/qr      # опрос статуса (или слушай DSMOD_QR в WS)
# → { "status": "waiting" | "scanned" | "approved" | "cancelled" | "expired", ... }
```

`qrImage` — готовый SVG data-URI: UI рисует `<img src="...">` и не подключает qr-библиотеки.

Статусы: `waiting` (код живёт ~120 c) → `scanned` (жмём «Подтвердить» на телефоне) →
`approved` (в ответе один раз будет `token`) или `cancelled` / `expired` / `error`.

Отмена: `POST /api/auth/qr/cancel`.

## 3. Готовый токен

```bash
curl -X POST http://127.0.0.1:8787/api/auth/token -H "Content-Type: application/json" -d '{"token":"..."}'
```

или переменная окружения `DSMOD_TOKEN` (см. `.env.example`). Токен никогда не попадает
в логи и не отдаётся обратно в UI — после входа его знает только мост.

## Хранение сессии

| Что | Где |
|---|---|
| Токен | `~/.dsmod/session.json` (переопределяется `DSMOD_SESSION_PATH`) |
| Окружение | `.env` (в `.gitignore`) |
| Выход | `POST /api/auth/logout` → удаляет файл, роняет gateway |

**Никогда** не клади токен в git, в UI-бандл или в localStorage.

## План

- [ ] `phone` challenge: `POST /phone-verifications/verify` уже реализован в SDK
      (`src/auth/password.ts` → `verifyPhone`, `authorizeIp`), не выведен в HTTP-мост.
- [ ] `email_code` challenge: endpoint подтверждения не документирован Discord'ом —
      нужен реверс клиента.
- [ ] WebAuthn/U2F MFA — не реализовано.
