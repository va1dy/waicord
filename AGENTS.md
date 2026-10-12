# AGENTS.md

> TL;DR для людей: работаем по веткам, каждый в своей зоне, в `main` не коммитим напрямую, ИИ проверяет код перед коммитом.

Rules for humans + AI agents. **Read before every session.**

## 0. Who owns what

Two humans: **Dev A** = _UI_, **Dev B** = _логика/бэкенд_. Each has their own AI assistant.

| Path | Dev A (UI) | Dev B (logic) |
|---|---|---|
| `apps/web/src/components/**` | own | read-only |
| `apps/web/src/app/**` | own | read-only |
| `apps/web/src/lib/**`, `apps/web/src/server/**` | read-only | own |
| shared (see list) | PR + both approvals | PR + both approvals |

**Shared files — change only via PR reviewed by BOTH humans:**
`package.json`, `pnpm-workspace.yaml`, root configs, `AGENTS.md`, `LICENSE`, `.env.example`, `.github/**`, `docs/ARCHITECTURE.md`

If a task needs a shared file — stop, ask your human, open a PR.

## 1. Stack (locked until both agree)

- Node.js >= 20, pnpm workspaces
- `apps/web` — Next.js + React (TypeScript)
- New dependency = PR with a reason. No silent `npm install`.

## 2. Git workflow

- `main` is protected: no direct commits, no force-push, no `reset --hard`.
- Branch names: `feature/<a|b>/<short-name>`, `fix/<a|b>/<short-name>`.
- Commits: Conventional Commits — `feat(web): …`, `fix: …`, `docs: …`, `chore: …`
- Before starting work: `git fetch origin && git rebase origin/main`
- Small PRs, one logical change each.

## 3. AI agents must

1. Work only inside your human's owned paths; anything shared → stop and ask the human.
2. Before declaring done, run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and fix all failures.
3. Never invent or store secrets; tokens live only in `.env` (gitignored); update `.env.example` via PR.
4. Keep diffs minimal: no drive-by refactors, no reformatting untouched files.
5. Never auto-resolve merge conflicts, never force-push, never commit on behalf of humans.
6. Match existing code style; no comments unless non-obvious.
7. If both AI sessions touched the same file — humans decide, agents wait.

## 4. PR checklist

- [ ] typecheck, lint, tests green
- [ ] no secrets in diff
- [ ] PR title = Conventional Commit, body explains what & why
- [ ] shared-file PR → both humans approved

## 5. Sync

- Start of session: pull `main`, check open PRs.
- Border questions (UI ↔ logic/API): decide together, record in `docs/ARCHITECTURE.md`.
- When in doubt — ask a human. A question costs a minute, a broken `main` costs an evening.
