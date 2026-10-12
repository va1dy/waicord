# Architecture

## Overview

Waicord = Discord bot + web dashboard. TypeScript monorepo, pnpm workspaces.

## apps/bot (Dev A)

- discord.js v14, TypeScript, `tsx` for dev
- Layout: `src/index.ts` (entry), `src/commands/` (one file per slash command), `src/events/` (one file per event)
- Config from `.env` (see `.env.example`)

## apps/web (Dev B)

- Next.js (App Router) + React + Tailwind
- Layout: `src/app/` (routes), `src/components/`

## Bot ↔ Web

TBD — варианты: REST API в боте, или общая БД. Решение записываем здесь, после обсуждения.

## Shared

Root configs, CI, docs — только через PR с одобрением обоих (см. AGENTS.md).

## Decisions log

- 2026-10-12: pnpm workspaces, layout `apps/*`, стек bot = discord.js, web = Next.js.
