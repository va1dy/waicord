<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import ChatView from "./ChatView.svelte";
  import FriendsPage from "../pages/FriendsPage.svelte";
  import GlowCanvas from "./GlowCanvas.svelte";
  import { app } from "../lib/app.svelte";
  import { avatarOf, type ChatDTO, type UserDTO } from "../lib/api";

  const dmChats = $derived(app.chats.filter((c) => c.kind === "dm" || c.kind === "group"));
  const pendingCount = $derived(app.pendingCount());

  function dmTitle(chat: ChatDTO): string {
    if (chat.kind === "group") return chat.name || "Группа";
    const other = chat.recipients.find((u) => u.id !== app.me?.id) ?? chat.recipients[0];
    return other?.displayName || other?.username || "чат";
  }

  function dmPeer(chat: ChatDTO): UserDTO | undefined {
    if (chat.kind !== "dm") return undefined;
    return chat.recipients.find((u) => u.id !== app.me?.id) ?? chat.recipients[0];
  }

  function chatActive(id: string): boolean {
    const view = app.active;
    return view.kind === "chat" && view.id === id;
  }

  function logout() {
    void app.logout();
  }
</script>

<div class="relative h-full min-h-0">
  <GlowCanvas />
  <div class="relative z-10 flex h-full min-h-0">
    <aside class="flex w-64 shrink-0 flex-col border-r border-line/60 bg-panel/60 backdrop-blur-md">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-line/60 px-4">
      <img src="/waicord-mark.svg" class="size-4" alt="" aria-hidden="true" />
      <span class="truncate text-[13px] font-semibold">Discord</span>
      <span
        class="ml-auto size-2 shrink-0 rounded-full {app.gatewayStatus === 'ready'
          ? 'bg-emerald-400'
          : 'bg-fg-muted/40'}"
        title={app.gatewayStatus}
      ></span>
    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto p-2 text-[13px]">
      <button
        type="button"
        onclick={() => void app.openFriends()}
        class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 font-medium transition {app.active.kind === 'friends'
          ? 'bg-panel-soft text-fg'
          : 'text-fg-muted hover:bg-panel-soft/60 hover:text-fg'}"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Друзья
        {#if pendingCount > 0}
          <span class="ml-auto grid min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">
            {pendingCount}
          </span>
        {/if}
      </button>

      <div class="mt-4">
        <div class="px-2.5 pb-1">
          <span class="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">Личные сообщения</span>
        </div>
        {#if dmChats.length === 0}
          <p class="px-2.5 py-1 text-[12px] text-fg-muted/70">Пока пусто</p>
        {/if}
        {#each dmChats as chat (chat.id)}
          {@const peer = dmPeer(chat)}
          <button
            type="button"
            onclick={() => void app.openChat(chat.id)}
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition {chatActive(chat.id)
              ? 'bg-panel-soft text-fg'
              : 'text-fg-muted hover:bg-panel-soft/60 hover:text-fg'}"
          >
            {#if chat.kind === "group"}
              <span class="grid size-[30px] shrink-0 place-items-center rounded-full bg-panel-soft text-[13px]" aria-hidden="true">👥</span>
            {:else}
              <span class="relative shrink-0">
                <Avatar username={peer?.username ?? "?"} url={avatarOf(peer)} defaultIndex={peer?.defaultAvatarIndex} size={30} />
                {#if peer && app.presence[peer.id] === "online"}
                  <span class="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-panel bg-emerald-400"></span>
                {/if}
              </span>
            {/if}
            <span class="truncate">{dmTitle(chat)}</span>
            {#if (app.unread[chat.id] ?? 0) > 0 && !chatActive(chat.id)}
              <span class="ml-auto grid min-w-5 shrink-0 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">
                {app.unread[chat.id]}
              </span>
            {/if}
          </button>
        {/each}
      </div>

      {#if app.guilds.length > 0}
        <div class="mt-4">
          <div class="px-2.5 pb-1">
            <span class="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">Серверы</span>
          </div>
          {#each app.guilds as guild (guild.id)}
            {@const channels = app.guildChannels[guild.id] ?? []}
            <div class="mt-1">
              <p class="truncate px-2.5 py-1 text-[12px] font-semibold text-fg/90">{guild.name}</p>
              {#if channels.length === 0}
                <p class="px-2.5 pb-1 text-[11px] text-fg-muted/60">Нет текстовых каналов</p>
              {/if}
              {#each channels as ch (ch.id)}
                <button
                  type="button"
                  onclick={() => void app.openChat(ch.id)}
                  class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left transition {chatActive(ch.id)
                    ? 'bg-panel-soft text-fg'
                    : 'text-fg-muted hover:bg-panel-soft/60 hover:text-fg'}"
                >
                  <span class="text-fg-muted/60" aria-hidden="true">#</span>
                  <span class="truncate">{ch.name}</span>
                  {#if (app.unread[ch.id] ?? 0) > 0 && !chatActive(ch.id)}
                    <span class="ml-auto grid min-w-5 shrink-0 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">
                      {app.unread[ch.id]}
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    </nav>

    <footer class="shrink-0 border-t border-line/60 bg-panel-soft/40 px-3 py-2">
      <div class="flex items-center gap-2.5">
        <div class="flex min-w-0 flex-1 items-center gap-2.5">
          <Avatar username={app.me?.username ?? "?"} url={avatarOf(app.me)} defaultIndex={app.me?.defaultAvatarIndex} size={32} />
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-semibold">{app.me?.displayName || app.me?.username}</p>
            <p class="truncate text-[11px] text-fg-muted">@{app.me?.username}</p>
          </div>
        </div>
        <button
          type="button"
          onclick={logout}
          class="grid size-8 place-items-center rounded-lg text-fg-muted transition hover:bg-white/5 hover:text-fg"
          title="Выйти"
          aria-label="Выйти"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </footer>
  </aside>

  <main class="flex min-w-0 flex-1 flex-col">
    {#if app.error}
      <p class="border-b border-danger/30 bg-danger/10 px-4 py-2 text-[12px] text-danger">{app.error}</p>
    {/if}
    {#if !app.ready}
      <p class="p-6 text-center text-[13px] text-fg-muted">Загрузка…</p>
    {:else if app.active.kind === "friends"}
      <FriendsPage />
    {:else}
      <ChatView />
    {/if}
  </main>
  </div>
</div>
