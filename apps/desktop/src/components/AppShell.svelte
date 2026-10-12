<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import ChatView from "./ChatView.svelte";
  import FriendsPage from "../pages/FriendsPage.svelte";
  import { app } from "../lib/app.svelte";

  let newChannel = $state("");
  let addingChannel = $state(false);
  let channelError = $state("");

  function dmTitle(id: string): string {
    const conv = app.dms.find((d) => d.id === id);
    if (!conv) return "чат";
    if (conv.kind === "group") return conv.name ?? "Группа";
    const other = conv.members.find((m) => m.id !== app.session?.user.id) ?? conv.members[0];
    return other?.username ?? "чат";
  }

  function dmOnline(id: string): boolean {
    const conv = app.dms.find((d) => d.id === id);
    if (!conv || conv.kind !== "dm") return false;
    const other = conv.members.find((m) => m.id !== app.session?.user.id);
    if (!other) return false;
    const friend = app.friends.find((f) => f.id === other.id);
    return !!friend?.online;
  }

  async function submitChannel(event: Event) {
    event.preventDefault();
    const name = newChannel.trim();
    if (!name) return;
    channelError = "";
    try {
      await app.addChannel(name);
      newChannel = "";
      addingChannel = false;
    } catch (error) {
      channelError = error instanceof Error ? error.message : "Не удалось создать канал";
    }
  }

  function logout() {
    app.logout();
  }
</script>

<div class="flex h-full min-h-0">
  <aside class="flex w-64 shrink-0 flex-col border-r border-line/60 bg-panel/50">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-line/60 px-4">
      <img src="/waicord-mark.svg" class="size-4" alt="" aria-hidden="true" />
      <span class="truncate text-[13px] font-semibold">{app.session?.server.replace(/^https?:\/\//, "")}</span>
      <span
        class="ml-auto size-2 shrink-0 rounded-full {app.wsOpen ? 'bg-emerald-400' : 'bg-fg-muted/40'}"
        title={app.wsOpen ? "подключено" : "нет соединения"}
      ></span>
    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto p-2 text-[13px]">
      <button
        type="button"
        onclick={() => app.openFriends()}
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
        {#if app.incomingCount > 0}
          <span class="ml-auto grid min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">
            {app.incomingCount}
          </span>
        {/if}
      </button>

      <div class="mt-4">
        <div class="flex items-center justify-between px-2.5 pb-1">
          <span class="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">Личные сообщения</span>
          <button
            type="button"
            onclick={() => app.openFriends()}
            class="grid size-6 place-items-center rounded-md text-fg-muted transition hover:bg-panel-soft hover:text-fg"
            title="Написать или создать группу"
            aria-label="Новое сообщение"
          >
            +
          </button>
        </div>
        {#if app.dms.length === 0}
          <p class="px-2.5 py-1 text-[12px] text-fg-muted/70">Пока пусто</p>
        {/if}
        {#each app.dms as conv (conv.id)}
          <button
            type="button"
            onclick={() => app.openDm(conv.id)}
            class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition {app.active.kind ===
            'dm' && app.active.id === conv.id
              ? 'bg-panel-soft text-fg'
              : 'text-fg-muted hover:bg-panel-soft/60 hover:text-fg'}"
          >
            {#if conv.kind === "group"}
              <span class="grid size-[30px] shrink-0 place-items-center rounded-full bg-panel-soft text-[13px]" aria-hidden="true">👥</span>
            {:else}
              {@const other = conv.members.find((m) => m.id !== app.session?.user.id) ?? conv.members[0]}
              <span class="relative shrink-0">
                <Avatar username={other?.username ?? "?"} size={30} />
                {#if dmOnline(conv.id)}
                  <span class="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-panel bg-emerald-400"></span>
                {/if}
              </span>
            {/if}
            <span class="truncate">{dmTitle(conv.id)}</span>
          </button>
        {/each}
      </div>

      <div class="mt-4">
        <div class="flex items-center justify-between px-2.5 pb-1">
          <span class="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">Каналы</span>
          <button
            type="button"
            onclick={() => (addingChannel = !addingChannel)}
            class="grid size-6 place-items-center rounded-md text-fg-muted transition hover:bg-panel-soft hover:text-fg"
            title="Создать канал"
            aria-label="Создать канал"
          >
            +
          </button>
        </div>
        {#if addingChannel}
          <form onsubmit={submitChannel} class="px-2 pb-2">
            <input
              name="channel-name"
              placeholder="имя-канала"
              bind:value={newChannel}
              autocomplete="off"
              class="h-8 w-full rounded-lg border border-line bg-panel-soft px-2 text-[12px] text-fg outline-none placeholder:text-fg-muted/60 focus:border-accent"
            />
            {#if channelError}
              <p class="mt-1 text-[11px] text-danger">{channelError}</p>
            {/if}
          </form>
        {/if}
        {#each app.channels as ch (ch.id)}
          <button
            type="button"
            onclick={() => app.openChannel(ch.id)}
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition {app.active.kind ===
            'channel' && app.active.id === ch.id
              ? 'bg-panel-soft text-fg'
              : 'text-fg-muted hover:bg-panel-soft/60 hover:text-fg'}"
          >
            <span class="text-fg-muted/60" aria-hidden="true">#</span>
            <span class="truncate">{ch.name}</span>
          </button>
        {/each}
      </div>
    </nav>

    <footer class="shrink-0 border-t border-line/60 bg-panel-soft/40 px-3 py-2">
      <div class="flex items-center gap-2.5">
        <Avatar username={app.session?.user.username ?? "?"} size={32} />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-semibold">{app.session?.user.username}</p>
          <p class="truncate text-[11px] text-fg-muted">{app.session?.user.email}</p>
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
