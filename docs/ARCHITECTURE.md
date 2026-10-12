# Architecture

## Overview

Waicord — Discord-подобный клиент, написанный с нуля, со своей UI.
TypeScript monorepo (pnpm workspaces).

## apps/web (пока единственное приложение)

- Next.js (App Router) + React, TypeScript
- `src/app/**` — страницы/роуты
- `src/components/**` — UI-компоненты (сайдбар, каналы, сообщения, ввод)
- `src/lib/**` — логика, утилиты
- `src/server/**` — бэкенд, когда появится

## Пока не решено (обсуждаем вместе)

- Бэкенд / БД / realtime — варианты и решения записываем сюда.

## Shared

Root configs, docs — только через PR с одобрением обоих (см. AGENTS.md).

## Decisions log

- 2026-10-12: pnpm workspaces, layout `apps/*`.
- 2026-10-12: фокус — клиент «дискорд с нуля» со своей UI; бот-скелет и README удалены.
