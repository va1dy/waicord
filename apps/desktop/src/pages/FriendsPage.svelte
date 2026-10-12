<script lang="ts">
  import { app } from "../lib/app.svelte";
  import Avatar from "../components/Avatar.svelte";

  type Tab = "all" | "pending" | "add" | "group";

  let tab = $state<Tab>("all");
  let addName = $state("");
  let addBusy = $state(false);
  let addError = $state("");
  let addOk = $state("");

  let groupName = $state("");
  let groupSel = $state<string[]>([]);
  let groupBusy = $state(false);
  let groupError = $state("");

  const pendingCount = $derived(app.incoming.length + app.outgoing.length);

  async function submitAdd(event: Event) {
    event.preventDefault();
    const username = addName.trim();
    if (!username || addBusy) return;
    addBusy = true;
    addError = "";
    addOk = "";
    try {
      addOk = await app.addFriend(username);
      addName = "";
    } catch (error) {
      addError = error instanceof Error ? error.message : "Не удалось отправить заявку";
    } finally {
      addBusy = false;
    }
  }

  async function write(username: string) {
    try {
      await app.startDm(username);
    } catch (error) {
      addError = error instanceof Error ? error.message : "Не удалось открыть чат";
    }
  }

  function toggleGroup(id: string) {
    groupSel = groupSel.includes(id) ? groupSel.filter((x) => x !== id) : [...groupSel, id];
  }

  async function submitGroup(event: Event) {
    event.preventDefault();
    if (groupSel.length < 1 || groupBusy) return;
    groupBusy = true;
    groupError = "";
    try {
      const usernames = app.friends.filter((f) => groupSel.includes(f.id)).map((f) => f.username);
      await app.createGroup(usernames, groupName.trim() || undefined);
      groupName = "";
      groupSel = [];
      tab = "all";
    } catch (error) {
      groupError = error instanceof Error ? error.message : "Не удалось создать группу";
    } finally {
      groupBusy = false;
    }
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
      { id: "add", label: "Добавить" },
      { id: "group", label: "Группа" },
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
    {#if tab === "add"}
      <form onsubmit={submitAdd} class="flex max-w-md items-end gap-2">
        <label class="min-w-0 flex-1">
          <span class="mb-1.5 block text-[13px] font-medium text-fg-muted">Логин друга</span>
          <input
            name="friend-username"
            placeholder="cool_user"
            bind:value={addName}
            autocomplete="off"
            class="h-11 w-full rounded-xl border border-line bg-panel-soft px-3.5 text-[15px] text-fg transition outline-none placeholder:text-fg-muted/60 focus:border-accent"
          />
        </label>
        <button
          type="submit"
          disabled={addBusy || !addName.trim()}
          class="h-11 shrink-0 rounded-xl bg-accent px-4 text-[13px] font-semibold text-ink transition hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-50"
        >
          {addBusy ? "…" : "Отправить заявку"}
        </button>
      </form>
      {#if addError}
        <p class="mt-3 max-w-md rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {addError}
        </p>
      {/if}
      {#if addOk}
        <p class="mt-3 max-w-md rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[13px] text-accent">
          {addOk}
        </p>
      {/if}

    {:else if tab === "pending"}
      <section class="max-w-xl">
        <h2 class="text-[12px] font-semibold tracking-wide text-fg-muted uppercase">Входящие</h2>
        {#if app.incoming.length === 0}
          <p class="mt-2 text-[13px] text-fg-muted">Пока пусто.</p>
        {/if}
        {#each app.incoming as req (req.request_id)}
          <div class="mt-2 flex items-center gap-3 rounded-xl border border-line/50 bg-panel/40 px-3 py-2">
            <Avatar username={req.username} url={req.avatar_url ?? null} size={32} />
            <span class="min-w-0 flex-1 truncate text-[14px] font-medium">{req.display_name || req.username}</span>
            <button
              type="button"
              onclick={() => req.request_id && app.acceptRequest(req.request_id)}
              class="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:bg-accent-strong"
            >
              Принять
            </button>
            <button
              type="button"
              onclick={() => req.request_id && app.declineRequest(req.request_id)}
              class="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition hover:text-fg"
            >
              Отклонить
            </button>
          </div>
        {/each}

        <h2 class="mt-6 text-[12px] font-semibold tracking-wide text-fg-muted uppercase">Исходящие</h2>
        {#if app.outgoing.length === 0}
          <p class="mt-2 text-[13px] text-fg-muted">Пока пусто.</p>
        {/if}
        {#each app.outgoing as req (req.request_id)}
          <div class="mt-2 flex items-center gap-3 rounded-xl border border-line/50 bg-panel/40 px-3 py-2">
            <Avatar username={req.username} url={req.avatar_url ?? null} size={32} />
            <span class="min-w-0 flex-1 truncate text-[14px] font-medium">{req.display_name || req.username}</span>
            <span class="text-[12px] text-fg-muted">Ожидает ответа</span>
            <button
              type="button"
              onclick={() => req.request_id && app.declineRequest(req.request_id)}
              class="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition hover:text-fg"
            >
              Отменить
            </button>
          </div>
        {/each}
      </section>

    {:else if tab === "group"}
      <form onsubmit={submitGroup} class="max-w-xl space-y-4">
        <label class="block">
          <span class="mb-1.5 block text-[13px] font-medium text-fg-muted">Название группы</span>
          <input
            name="group-name"
            placeholder="Например: Дота-сquad"
            bind:value={groupName}
            autocomplete="off"
            class="h-11 w-full rounded-xl border border-line bg-panel-soft px-3.5 text-[15px] text-fg transition outline-none placeholder:text-fg-muted/60 focus:border-accent"
          />
        </label>
        <div>
          <span class="mb-2 block text-[13px] font-medium text-fg-muted">Участники (друзья)</span>
          {#if app.friends.length === 0}
            <p class="text-[13px] text-fg-muted">Сначала добавь друзей.</p>
          {/if}
          <div class="space-y-1">
            {#each app.friends as f (f.id)}
              <label class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-panel-soft/60">
                <input type="checkbox" checked={groupSel.includes(f.id)} onchange={() => toggleGroup(f.id)} class="accent-accent" />
                <Avatar username={f.username} url={f.avatar_url ?? null} size={24} />
                <span class="text-[14px]">{f.display_name || f.username}</span>
                {#if f.online}
                  <span class="ml-auto size-2 rounded-full bg-emerald-400" aria-label="онлайн"></span>
                {/if}
              </label>
            {/each}
          </div>
        </div>
        {#if groupError}
          <p class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">{groupError}</p>
        {/if}
        <button
          type="submit"
          disabled={groupBusy || groupSel.length < 1}
          class="h-11 rounded-xl bg-accent px-5 text-[13px] font-semibold text-ink transition hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-50"
        >
          {groupBusy ? "…" : `Создать группу (${groupSel.length})`}
        </button>
      </form>

    {:else}
      {#if app.friends.length === 0}
        <p class="text-[13px] text-fg-muted">Пока никого. Добавь друга по логину — вкладка «Добавить».</p>
      {/if}
      <div class="max-w-xl space-y-1">
        {#each app.friends as f (f.id)}
          <div class="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-panel-soft/50">
            <div class="relative">
              <Avatar username={f.username} url={f.avatar_url ?? null} size={34} />
              {#if f.online}
                <span class="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-ink bg-emerald-400"></span>
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[14px] font-medium">{f.display_name || f.username}</p>
              <p class="text-[12px] text-fg-muted">{f.online ? (f.status || "в сети") : (f.status ? `${f.status} · не в сети` : "не в сети")}</p>
            </div>
            <button
              type="button"
              onclick={() => write(f.username)}
              class="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg transition hover:border-accent/40 hover:bg-panel-soft"
            >
              Написать
            </button>
            <button
              type="button"
              onclick={() => app.deleteFriend(f.id)}
              class="rounded-lg px-2 py-1.5 text-[12px] font-medium text-fg-muted transition hover:text-danger"
              title="Удалить из друзей"
            >
              ✕
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
