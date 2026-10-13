/**
 * dsmod — публичный API.
 *
 * Импортируй отсюда: `import { DscClient } from "./src/index"`.
 */
export { DscClient, type ClientEventMap } from "./client";
export { Resources, type MessageQuery, type SendMessagePayload } from "./resources";
export { DiscordRest, type HttpMethod, type RequestOptions } from "./http/client";
export { Authenticator, QrSession, loginWithPassword, solveMfa, loadSession, saveSession, clearSession } from "./auth";
export { GatewayClient, DEFAULT_BOT_INTENTS, type GatewayOptions, type GatewayStatus } from "./gateway";
export { resolveOptions, API_VERSION, DEFAULT_USER_AGENT, type DscOptions } from "./config";
export { toChat, toGuild, toMessage, toUser, defaultAvatarUrl } from "./dto";
export * from "./errors";
export * from "./types";
export { startBridge, type Bridge, type BridgeOptions } from "./server/server";

import { DscClient } from "./client";

/**
 * Удобный конструктор: создаёт клиент и сразу подхватывает сохранённую сессию.
 *
 * ```ts
 * const client = await createClient();
 * if (!client.isAuthenticated) await client.login({ email, password });
 * ```
 */
export async function createClient(options: ConstructorParameters<typeof DscClient>[0] = {}): Promise<DscClient> {
  const client = new DscClient(options);
  await client.restore();
  return client;
}
