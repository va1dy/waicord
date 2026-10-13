<script lang="ts">
  import { app } from "../lib/app.svelte";
  import Avatar from "../components/Avatar.svelte";

  type Tab = "all" | "pending";
  type FriendRow = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    defaultAvatarIndex: number;
  };

  let tab = $state<Tab>("all");

  const pendingCount = $derived(app.pendingCount());

  function statusLabel(id: string): string {
    const p = app.presence[id];
    if (p === "online") return "в сети";
    if (p === "idle") return "неактивен";
    if (p === "dnd") return "не беспокоить";
    return "не в сети";
  }

  function statusColor(id: string): string {
    const p = app.presence[id];
    if (p === "online") return "bg-emerald-400";
    if (p === "idle") return "bg-amber-400";
    if (p === "dnd") return "bg-danger";
    return "bg-fg-muted/40";
  }

  function dmChatId(userId: string): string | undefined {
    const chat = app.chats.find((c) => c.kind === "dm" && c.recipients.some((u) => u.id === userId));
    return chat?.id;
  }

  function write(f: FriendRow) {
    const id = dmChatId(f.id);
    if (id) void app.openChat(id);
  }

  function nameOf(f: FriendRow): string {
    return f.displayName || f.username;
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-11 shrink-0 items-center border-b border-line/60 px-4">
    <h1 class="text-[14px] font-semibold">Друзья</h1>
  </header>

  <nav class="flex shrink-0 gap-1 border-b border-line/40 px-3 pt-2" aria-label="Вкладки друзей">
    {#each [
      { id: "all", label: "Все" },
      { id: "pending", label: pendingCount ? `Ожидание (${pendingCount})` : "Ожидание" },
    ] as t (t.id)}
      <button
        type="button"
        onclick={() => (tab = t.id as Tab)}
        class="rounded-t-lg px-3 py-1.5 text-[13px] font-medium transition {tab === t.id
          ? 'bg-panel-soft text-fg'
          : 'text-fg-muted hover:text-fg'}"
      >
        {t.label}
      </button>
    {/each}
  </nav>

  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    {#if tab === "pending"}
      <section class="max-w-xl">
        <h2 class="text-[12px] font-semibold tracking-wide text-fg-muted uppercase">Входящие</h2>
        {#if app.incoming.length === 0}
          <p class="mt-2 text-[13px] text-fg-muted">Пока пусто.</p>
        {/if}
        {#each app.incoming as req (req.id)}
          <div class="mt-2 flex items-center gap-3 rounded-xl border border-line/50 bg-panel/40 px-3 py-2">
            <Avatar username={req.username} url={req.avatarUrl} defaultIndex={req.defaultAvatarIndex} size={32} />
            <span class="min-w-0 flex-1 truncate text-[14px] font-medium">{nameOf(req)}</span>
            <span class="text-[12px] text-fg-muted">Хочет в друзья</span>
          </div>
        {/each}

        <h2 class="mt-6 text-[12px] font-semibold tracking-wide text-fg-muted uppercase">Исходящие</h2>
        {#if app.outgoing.length === 0}
          <p class="mt-2 text-[13px] text-fg-muted">Пока пусто.</p>
        {/if}
        {#each app.outgoing as req (req.id)}
          <div class="mt-2 flex items-center gap-3 rounded-xl border border-line/50 bg-panel/40 px-3 py-2">
            <Avatar username={req.username} url={req.avatarUrl} defaultIndex={req.defaultAvatarIndex} size={32} />
            <span class="min-w-0 flex-1 truncate text-[14px] font-medium">{nameOf(req)}</span>
            <span class="text-[12px] text-fg-muted">Ожидает ответа</span>
          </div>
        {/each}
        <p class="mt-4 text-[12px] text-fg-muted/70">
          Принять/отклонить заявки можно в официальном Discord — мост пока поддерживает только просмотр.
        </p>
      </section>
    {:else}
      {#if app.friends.length === 0}
        <p class="text-[13px] text-fg-muted">Пока никого. Список подтянется из Discord после входа.</p>
      {/if}
      <div class="max-w-xl space-y-1">
        {#each app.friends as f (f.id)}
          {@const chatId = dmChatId(f.id)}
          <div class="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-panel-soft/50">
            <div class="relative">
              <Avatar username={f.username} url={f.avatarUrl} defaultIndex={f.defaultAvatarIndex} size={34} />
              <span class="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-ink {statusColor(f.id)}"></span>
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[14px] font-medium">{nameOf(f)}</p>
              <p class="text-[12px] text-fg-muted">@{f.username} · {statusLabel(f.id)}</p>
            </div>
            <button
              type="button"
              onclick={() => write(f)}
              disabled={!chatId}
              title={chatId ? "Открыть чат" : "ЛС ещё не открыто — напиши в официальном Discord"}
              class="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg transition hover:border-accent/40 hover:bg-panel-soft disabled:pointer-events-none disabled:opacity-40"
            >
              Написать
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
