/**
 * Тонкая обёртка над API бэкенда.
 * TODO(api): заменить заглушку на реальные вызовы, когда API будет готов.
 */

export async function login(identifier: string, password: string): Promise<void> {
  void identifier;
  void password;
  throw new Error("API ещё не подключён: вход заработает, когда бэкенд будет готов");
}
