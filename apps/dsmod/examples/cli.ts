#!/usr/bin/env bun
/**
 * Консольный клиент — удобно проверять API без UI.
 *
 *   bun run examples/cli.ts login <email>
 *   bun run examples/cli.ts qr
 *   bun run examples/cli.ts state
 *   bun run examples/cli.ts chats
 *   bun run examples/cli.ts read <channelId> [limit]
 *   bun run examples/cli.ts send <channelId> <текст...>
 *   bun run examples/cli.ts gateway
 *   bun run examples/cli.ts logout
 */
import { createInterface } from "node:readline/promises";
import { createClient } from "../src/index";
import { qrTerminal } from "../src/qr-image";
import type { AuthResult } from "../src/types";

const [command = "help", ...args] = process.argv.slice(2);
const rl = createInterface({ input: process.stdin, output: process.stdout });

/** Пароль не должен отражаться в терминале. */
function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return rl.question(question);
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

function report(result: AuthResult) {
  if (result.ok) {
    console.log("✓ вход выполнен, токен сохранён в ~/.dsmod/session.json");
    return;
  }
  const { challenge, error } = result;
  console.log("× вход не завершён:", error.code, "—", error.message);
  if (challenge?.type === "mfa") console.log("  нужен код MFA:", challenge.methods.join(", "), "| ticket:", challenge.ticket);
  if (challenge?.type === "captcha") console.log("  Discord запросил капчу — повтори вход позже или через UI");
}

async function main() {
  const client = await createClient();

  switch (command) {
    case "login": {
      const email = args[0] ?? (await rl.question("email: "));
      const password = await askHidden("password: ");
      const first = await client.login({ email, password });
      report(first);
      if (!first.ok && first.challenge?.type === "mfa") {
        const method = args[1] === "sms" ? "sms" : "totp";
        if (method === "sms") {
          const phone = await client.auth.sendMfaSms(first.challenge.ticket);
          console.log("SMS отправлен на", phone);
        }
        const code = await rl.question(`код ${method}: `);
        const second = await client.solveMfa(first.challenge, { code, method });
        report(second);
      }
      break;
    }

    case "qr": {
      const session = client.startQr();
      session.on("scanned", (state) => console.log(`… отсканировано: ${state.user?.username ?? "?"} — подтверди на телефоне`));
      const url = await session.start();
      console.log(await qrTerminal(url));
      console.log("Открой Discord на телефоне → Настройки → «Войти на другом устройстве» и наведи камеру.");
      const token = await session.waitForToken();
      await client.useToken(token);
      console.log("✓ вход по QR выполнен");
      break;
    }

    case "state": {
      const me = client.isAuthenticated ? await client.loadMe() : null;
      const chats = client.isAuthenticated ? await client.api.chats() : [];
      console.log(JSON.stringify({ authenticated: client.isAuthenticated, me, chats: chats.length }, null, 2));
      break;
    }

    case "chats": {
      const chats = await client.api.chats();
      for (const chat of chats) {
        const kind = chat.kind === "dm" ? "@" : chat.kind === "group" ? "⌂" : "#";
        console.log(`${chat.id}  ${kind} ${chat.name}`);
      }
      if (chats.length === 0) console.log("чатов нет");
      break;
    }

    case "read": {
      const channelId = args[0] ?? (await rl.question("channel id: "));
      const limit = Number(args[1] ?? 20);
      const messages = await client.api.messages(channelId, { limit });
      for (const m of [...messages].reverse()) {
        const time = m.timestamp.slice(11, 16);
        console.log(`[${time}] ${m.author.displayName}: ${m.content || "…"}`);
      }
      break;
    }

    case "send": {
      const channelId = args[0];
      const content = args.slice(1).join(" ");
      if (!channelId || !content) throw new Error("usage: send <channelId> <текст...>");
      const message = await client.api.send(channelId, content);
      console.log("✓ отправлено:", message.id);
      break;
    }

    case "gateway": {
      await client.connect();
      console.log("gateway:", client.gateway?.status, "| события (Ctrl+C для выхода)");
      client.on("event", (frame) => console.log(`${frame.ts} ${frame.t}`));
      await new Promise(() => {});
      break;
    }

    case "logout": {
      await client.logout();
      console.log("✓ вышли");
      break;
    }

    default:
      console.log(`dsmod cli

  login <email>            вход по паролю (пароль спросит сам)
  qr                       вход по QR-коду
  state                    кто я и сколько чатов
  chats                    список чатов
  read <channelId> [n]     последние n сообщений
  send <channelId> <text>  отправить сообщение
  gateway                  подключить gateway и печатать события
  logout                   выйти`);
  }

  rl.close();
  client.disconnect();
}

main().catch((err) => {
  console.error("ошибка:", err instanceof Error ? err.message : err);
  rl.close();
  process.exit(1);
});
