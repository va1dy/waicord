#!/usr/bin/env bun
/**
 * Точка входа: `bun run src/server/main.ts` (или `bun start`).
 *
 * Поднимает локальный мост, на который потом смотрит UI (Tauri/браузер).
 * Аргументы:
 *   --port 8787        порт
 *   --host 127.0.0.1   хост (только loopback по умолчанию)
 *   --key  secret      требовать заголовок x-dsmod-key
 *   --no-gateway       не открывать Gateway на старте
 */
import { startBridge } from "./server";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const bridge = await startBridge({
  host: arg("host"),
  port: arg("port") ? Number(arg("port")) : undefined,
  key: arg("key") ?? null,
  connectGateway: !has("no-gateway"),
});

console.log(`dsmod bridge → ${bridge.url}`);
console.log(`  health : GET  ${bridge.url}/api/health`);
console.log(`  state  : GET  ${bridge.url}/api/state`);
console.log(`  events : WS   ws://${new URL(bridge.url).hostname}:${bridge.port}/events`);
console.log(`  docs   : docs/api.md`);

const shutdown = () => {
  console.log("\nstopping…");
  bridge.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
