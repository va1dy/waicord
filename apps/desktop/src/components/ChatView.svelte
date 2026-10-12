<script lang="ts">
  import { tick } from "svelte";
  import Avatar from "./Avatar.svelte";
  import { app } from "../lib/app.svelte";
  import type { Message } from "../lib/api";

  const active = $derived(app.active);

  const title = $derived.by(() => {
    const view = active;
    if (view.kind === "channel") {
      const ch = app.channels.find((c) => c.id === view.id);
      return { icon: "#", label: ch?.name ?? "канал" };
    }
    if (view.kind === "dm") {
      const conv = app.dms.find((d) => d.id === view.id);
      if (!conv) return { icon: "@", label: "чат" };
      if (conv.kind === "group") return { icon: "👥", label: conv.name ?? "Группа" };
      const other = conv.members.find((m) => m.id !== app.session?.user.id) ?? conv.members[0];
      return { icon: "@", label: other?.username ?? "чат" };
    }
    return { icon: "", label: "" };
  });

  const dmConv = $derived(active.kind === "dm" ? app.dms.find((d) => d.id === active.id) : undefined);

  const key = $derived(app.viewKey());
  const messages = $derived((key && app.messages[key]) || ([] as Message[]));

  let draft = $state("");
  let sending = $state(false);
  let sendError = $state("");
  let listEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void messages.length;
    void key;
    tick().then(() => {
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    });
  });

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function groupMessages(msgs: Message[]) {
    const out: { author: string; id: string; items: { text: string; time: string }[] }[] = [];
    for (const m of msgs) {
      const last = out[out.length - 1];
      if (last && last.author === m.user.username) {
        last.items.push({ text: m.content, time: formatTime(m.created_at) });
      } else {
        out.push({
          author: m.user.username,
          id: m.id,
          items: [{ text: m.content, time: formatTime(m.created_at) }],
        });
      }
    }
    return out;
  }

  const grouped = $derived(groupMessages(messages));

  async function submit(event: Event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    sendError = "";
    try {
      await app.sendMessage(text);
      draft = "";
    } catch (error) {
      sendError = error instanceof Error ? error.message : "Не удалось отправить";
    } finally {
      sending = false;
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line/60 px-4">
    <span class="text-fg-muted" aria-hidden="true">{title.icon}</span>
    <h1 class="truncate text-[14px] font-semibold">{title.label}</h1>
    {#if active.kind === "dm" && dmConv}
      <span class="text-[12px] text-fg-muted">
        {dmConv.members.map((m) => m.username).join(", ")}
      </span>
    {/if}
  </header>

  <div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
    {#if messages.length === 0}
      <p class="mt-8 text-center text-[13px] text-fg-muted">Сообщений пока нет — напиши первым.</p>
    {/if}
    {#each grouped as group (group.id)}
      <div class="mt-3 flex gap-3 first:mt-0">
        <Avatar username={group.author} size={34} />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] font-semibold">{group.author}</span>
            <span class="text-[11px] text-fg-muted/70">{group.items[0]?.time}</span>
          </div>
          {#each group.items as item (item.time + item.text)}
            <p class="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-fg/95">{item.text}</p>
          {/each}
        </div>
      </div>
    {/each}
  </div>

  <footer class="shrink-0 px-4 pb-4">
    {#if sendError}
      <p class="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
        {sendError}
      </p>
    {/if}
    <form onsubmit={submit} class="flex items-end gap-2">
      <input
        name="message"
        placeholder="Написать сообщение…"
        bind:value={draft}
        autocomplete="off"
        class="h-11 min-w-0 flex-1 rounded-xl border border-line bg-panel-soft px-3.5 text-[14px] text-fg transition outline-none placeholder:text-fg-muted/60 focus:border-accent"
      />
      <button
        type="submit"
        disabled={sending || !draft.trim()}
        class="flex h-11 items-center justify-center rounded-xl bg-accent px-4 text-[13px] font-semibold text-ink transition hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-50"
      >
        {sending ? "…" : "Отправить"}
      </button>
    </form>
  </footer>
</div>
