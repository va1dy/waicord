# Десктоп на Tauri

Цель: `dsmod` работает как **sidecar-процесс** (Bun), а Tauri-окно — просто UI поверх
HTTP-моста. Токен остаётся в sidecar'е, фронтенд не знает о нём ничего.

```
┌────────────────────────┐        ┌──────────────────────┐
│ Tauri window (WebView) │ ─HTTP→ │ bun (dsmod bridge)   │ → Discord
│ http://127.0.0.1:8787  │ ←WS─── │ port 8787            │
└────────────────────────┘        └──────────────────────┘
```

## 1. Собрать sidecar

```bash
bun run build:exe
# то же самое руками:
# bun build --compile src/server/main.ts --asset examples/ui --outfile dist/dsmod-bridge.exe
```

Получается один самодостаточный файл `dist/dsmod-bridge.exe` (~92 МБ, внутри рантайм Bun
плюс встроенный демо-интерфейс). Проверка:

```bash
dist\dsmod-bridge.exe --port 8795     # откроет мост, лог — в консоли
curl http://127.0.0.1:8795/api/health
```

> `--asset examples/ui` вшивает демо-UI в бинарник: в скомпилированном exe
> `import.meta.dir` указывает на виртуальную ФС бандла (`B:\~BUN\root`), поэтому мост
> ищет `index.html` по списку кандидатов (см. `demoUiHtml` в `src/server/server.ts`):
> `DSMOD_UI_PATH` → путь рядом с exe → встроенный ассет → cwd. Если ничего не найдено,
> `GET /` вернёт JSON-индекс API, а сам мост продолжит работать.

Для Tauri sidecar положи бинарник в `src-tauri/binaries/` с суффиксом целевой триплета:

```
src-tauri/binaries/dsmod-bridge-x86_64-pc-windows-msvc.exe
```

## 2. `src-tauri/tauri.conf.json`

```jsonc
{
  "app": {
    // WebView может ходить только на локальный мост
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://127.0.0.1:8787 ws://127.0.0.1:8787; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "externalBin": ["binaries/dsmod-bridge"]
  }
}
```

## 3. Запуск bridge при старте приложения

`src-tauri/src/main.rs` (или плагин `tauri-plugin-shell`):

```rust
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let sidecar = app.shell().sidecar("dsmod-bridge")?;
            let (_rx, child) = sidecar
                .args(["--port", "8787"])
                .spawn()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Готово: окно открывает `http://127.0.0.1:8787/` (там лежит демо-UI) или свой билд.

## 4. Проверка, что мост жив

```ts
async function waitForBridge(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch("http://127.0.0.1:8787/api/health");
      if (r.ok) return true;
    } catch { /* мост ещё поднимается */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
```

`health` не требует токена и не зависит от `x-dsmod-key` — им можно пинговать.

## 5. Альтернатива: Tauri-команды вместо HTTP

Если не хочется держать открытый порт, тот же SDK можно засунуть в Rust-команды:

```rust
#[tauri::command]
async fn send_message(channel_id: String, content: String) -> Result<String, String> {
    // вызов bun-скрипта или перенос SDK на другой язык не требуется:
    // проще держать sidecar и проксировать запросы
    todo!()
}
```

На практике sidecar+HTTP проще: типы, документация и демо-UI уже готовы, а порт
случайным образом не поднимется на чужом IP — мост слушает только `127.0.0.1`.

## 6. Безопасность на десктопе

- мост **всегда** слушает `127.0.0.1` (не `0.0.0.0`);
- при желании запускай с `--key <случайная строка>` и передавай её в UI через
  Tauri-команду — чужой процесс на той же машине не сможет пользоваться API;
- сессия хранится в `~/.dsmod/session.json`, в WebView её копий нет;
- не включай `Access-Control-Allow-Origin: *` в проде, если UI открывается по
  `tauri://localhost` — сузь до этого origin (параметр пока хардкод, точечно правится
  в `src/server/server.ts`).

## 7. Режим разработки

```bash
bun start            # терминал 1: мост
bun run tauri dev    # терминал 2: окно
```

В `tauri dev` можно просто открыть `http://127.0.0.1:8787/` и править
`examples/ui/index.html` без пересборки — мост отдаёт его на `GET /`.
