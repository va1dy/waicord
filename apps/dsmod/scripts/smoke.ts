/**
 * Быстрая проверка локального моста вживую.
 *
 * Требуется поднятый bridge:  bun start
 * Запуск:                     bun run scripts/smoke.ts [baseUrl]
 */
const base = process.argv[2] ?? "http://127.0.0.1:8787";

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* оставляем как текст */
  }
  return { status: res.status, body: parsed };
}

const results: Array<[string, unknown]> = [];
results.push(["GET /", await call("GET", "/")]);
results.push(["GET /api/health", await call("GET", "/api/health")]);
results.push(["GET /api/state", await call("GET", "/api/state")]);
results.push(["GET /api/chats (без входа)", await call("GET", "/api/chats")]);
results.push(["POST /api/channels/0/messages (bad id)", await call("POST", "/api/channels/0/messages", { content: "hi" })]);
results.push(["GET /api/nope", await call("GET", "/api/nope")]);

for (const [name, value] of results) {
  console.log(`\n--- ${name}`);
  console.log(JSON.stringify(value, null, 2));
}
