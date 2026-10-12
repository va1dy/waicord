<div align="center">
  <img src="apps/desktop/public/waicord.svg" width="96" height="96" alt="waicord logo" />

  # waicord

  **An alternative, lightweight Discord client built with Rust + Tauri.**

  Native speed, tiny footprint, no Electron.

  <p>
    <img alt="version" src="https://img.shields.io/badge/version-0.1.0-FF9A3D?style=flat-square" />
    <img alt="status" src="https://img.shields.io/badge/status-early%20alpha-FF6B7A?style=flat-square" />
    <img alt="license" src="https://img.shields.io/github/license/va1dy/waicord?style=flat-square" />
    <img alt="stars" src="https://img.shields.io/github/stars/va1dy/waicord?style=flat-square&color=FF9A3D" />
  </p>
  <p>
    <img alt="rust" src="https://img.shields.io/badge/Rust-black?style=flat-square&logo=rust" />
    <img alt="tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" />
    <img alt="svelte" src="https://img.shields.io/badge/Svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white" />
    <img alt="tailwind" src="https://img.shields.io/badge/Tailwind%20CSS-4-0B72B7?style=flat-square&logo=tailwindcss&logoColor=white" />
    <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white" />
  </p>
</div>

---

## Why

Discord's official desktop client is an Electron app: heavy, slow to start and
hungry for RAM. `waicord` aims to be the opposite: a small, sharp client that
opens instantly and stays out of your way.

- **Fast startup**: Tauri uses the OS webview, the core is compiled Rust
- **Small footprint**: no bundled Chromium, binary measured in MB, not hundreds
- **Native feel**: real window controls, system tray, native notifications
- **Secure by default**: capability-scoped IPC, no Node.js in production
- **Yours**: open source, MIT licensed, no telemetry

## Tech stack

| Layer    | Tech                              |
| -------- | --------------------------------- |
| Core     | Rust + [Tauri 2](https://tauri.app) |
| UI       | Svelte 5 + TypeScript + Vite      |
| Styling  | Tailwind CSS 4                    |
| Fonts    | Inter, Manrope                    |
| Package  | Bun                               |

## Getting started

**Prerequisites:** [Rust](https://rustup.rs), [Bun](https://bun.sh), Windows 10+.

```bash
git clone https://github.com/va1dy/waicord.git
cd waicord/apps/desktop
bun install
bun run tauri dev      # dev build with hot reload
bun run tauri build    # release build
```

Useful scripts (run inside `apps/desktop`):

| Script             | What it does                          |
| ------------------ | ------------------------------------- |
| `bun run dev`      | Vite dev server only (browser)        |
| `bun run check`    | svelte-check type checking            |
| `bun run icons`    | Regenerate app icons from the SVG     |

## Project structure

```text
waicord/
├── apps/
│   └── desktop/              # Tauri desktop app
│       ├── public/
│       │   └── waicord.svg    # source of truth for the logo + favicon
│       ├── src/               # Svelte UI
│       │   ├── components/    # Logo, ui primitives
│       │   └── pages/         # Login, ...
│       └── src-tauri/         # Rust side
│           ├── src/           # main.rs
│           └── icons/         # generated from waicord.svg
├── AGENTS.md
└── LICENSE
```

## Status & roadmap

- [x] Tauri 2 + Svelte 5 shell, branding and icons
- [x] Login screen UI
- [ ] Discord gateway (WebSocket) auth
- [ ] Servers, channels, DMs
- [ ] Voice & video
- [ ] System tray, autostart, auto-updates

## Disclaimer

waicord is an independent, unofficial project. It is not affiliated with,
endorsed by or connected to Discord Inc. All Discord trademarks belong to
their respective owners.

## License

[MIT](LICENSE) © waicord contributors
