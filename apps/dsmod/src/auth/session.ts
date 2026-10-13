import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionDTO, UserDTO } from "../types";
import { toUser } from "../dto";

/** Читает сохранённую сессию (~/.dsmod/session.json). Если её нет — null. */
export async function loadSession(path: string): Promise<SessionDTO | null> {
  try {
    const text = await readFile(path, "utf8");
    const data = JSON.parse(text);
    if (typeof data?.token !== "string") return null;
    return {
      token: data.token,
      user: data.user ? toUser(data.user) : null,
      savedAt: data.savedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Сохраняет сессию. Файл содержит токен — не попадает в git (.gitignore). */
export async function saveSession(path: string, token: string, user?: UserDTO | null): Promise<SessionDTO> {
  const session: SessionDTO = { token, user: user ?? null, savedAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  return session;
}

/** Удаляет сессию (выход из аккаунта). */
export async function clearSession(path: string): Promise<void> {
  await rm(path, { force: true });
}
