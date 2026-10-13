<script lang="ts">
  import { tick } from "svelte";
  import Avatar from "./Avatar.svelte";
  import { app } from "../lib/app.svelte";
  import { avatarOf, searchGifs, type ChatDTO, type MessageDTO } from "../lib/api";

  const active = $derived(app.viewKey());
  const chat = $derived(
    Object.values(app.guildChannels)
      .flat()
      .concat(app.chats)
      .find((c) => c.id === active) as ChatDTO | undefined,
  );

  const title = $derived.by(() => {
    const c = chat;
    if (!c) return { icon: "", label: "чат" };
    if (c.kind === "guild") return { icon: "#", label: c.name || "канал" };
    if (c.kind === "group") return { icon: "👥", label: c.name || "Группа" };
    const other = c.recipients.find((u) => u.id !== app.me?.id) ?? c.recipients[0];
    return { icon: "@", label: other?.displayName || other?.username || "чат" };
  });

  const messages = $derived((active && app.messages[active]) || ([] as MessageDTO[]));
  const typingNames = $derived.by(() => {
    const list = app.typing[active] ?? [];
    const now = Date.now();
    return list.filter((x) => now - x.at < 8000).map((x) => x.name);
  });

  let draft = $state("");
  let sendError = $state("");
  let sending = $state(false);
  let listEl = $state<HTMLElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  let gifOpen = $state(false);
  let gifQuery = $state("");
  let gifs = $state<string[]>([]);
  let gifLoading = $state(false);
  let gifError = $state("");
  let gifTimer: ReturnType<typeof setTimeout> | undefined;

  let lastTypingAt = 0;

  $effect(() => {
    void messages.length;
    void active;
    tick().then(() => {
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    });
  });

  $effect(() => {
    void active;
    resetComposer();
    focusInput();
  });

  $effect(() => {
    if (!gifOpen) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") gifOpen = false;
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });

  function focusInput() {
    void tick().then(() => inputEl?.focus());
  }

  function resetComposer() {
    draft = "";
    gifOpen = false;
    gifQuery = "";
    gifs = [];
    gifError = "";
  }

  function onWindowKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    inputEl?.focus();
  }

  function formatTime(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  type Group = { authorId: string; author: string; avatarUrl: string | null; defaultIndex: number; id: string; items: MessageDTO[] };

  function groupMessages(msgs: MessageDTO[]): Group[] {
    const out: Group[] = [];
    for (const m of msgs) {
      const last = out[out.length - 1];
      if (last && last.authorId === m.author.id) {
        last.items.push(m);
      } else {
        out.push({
          authorId: m.author.id,
          author: m.author.displayName || m.author.username,
          avatarUrl: m.author.avatarUrl,
          defaultIndex: m.author.defaultAvatarIndex,
          id: m.id,
          items: [m],
        });
      }
    }
    return out;
  }

  const grouped = $derived(groupMessages(messages));

  function isImage(att: { contentType?: string | null; filename: string; url: string }): boolean {
    if (att.contentType?.startsWith("image/")) return true;
    return /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(att.filename) || att.url.includes("giphy");
  }

  function isVideo(att: { contentType?: string | null; filename: string }): boolean {
    if (att.contentType?.startsWith("video/")) return true;
    return /\.(webm|mp4|mov)$/i.test(att.filename);
  }

  function pickGif(url: string) {
    draft = draft ? `${draft} ${url}` : url;
    gifOpen = false;
    gifQuery = "";
    gifs = [];
    inputEl?.focus();
  }

  function searchGifNow(q: string) {
    gifError = "";
    if (!q.trim()) {
      gifs = [];
      return;
    }
    gifLoading = true;
    searchGifs(q)
      .then((urls) => {
        gifs = urls;
      })
      .catch((error: unknown) => {
        gifError = error instanceof Error ? error.message : "Не удалось найти гифки";
        gifs = [];
      })
      .finally(() => {
        gifLoading = false;
      });
  }

  function onGifInput() {
    clearTimeout(gifTimer);
    gifTimer = setTimeout(() => searchGifNow(gifQuery), 350);
  }

  function onDraftInput() {
    const now = Date.now();
    if (now - lastTypingAt > 5000 && draft.trim()) {
      lastTypingAt = now;
      if (active) void app.sendTyping(active);
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (sending) return;
    const text = draft.trim();
    if (!text) return;
    sending = true;
    sendError = "";
    try {
      await app.sendMessage(text);
      resetComposer();
      focusInput();
    } catch (error) {
      sendError = error instanceof Error ? error.message : "Не удалось отправить";
    } finally {
      sending = false;
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line/60 px-4">
    <span class="text-fg-muted" aria-hidden="true">{title.icon}</span>
    <h1 class="truncate text-[14px] font-semibold">{title.label}</h1>
    {#if chat?.kind === "dm"}
      {@const other = chat.recipients.find((u) => u.id !== app.me?.id) ?? chat.recipients[0]}
      {#if other}
        <span class="flex items-center gap-1.5 text-[12px] text-fg-muted">
          <span
            class="inline-block size-2 rounded-full {app.presence[other.id] === 'online'
              ? 'bg-[#3ba55d]'
              : 'bg-fg-muted/40'}"
            aria-hidden="true"
          ></span>
          {app.presence[other.id] === "online" ? "в сети" : "не в сети"}
        </span>
      {/if}
    {/if}
  </header>

  <div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
    {#if messages.length === 0}
      <p class="mt-8 text-center text-[13px] text-fg-muted">Сообщений пока нет — напиши первым.</p>
    {/if}
    {#each grouped as group (group.id)}
      <div class="mt-3 flex gap-3 first:mt-0">
        <Avatar username={group.author} url={group.avatarUrl} defaultIndex={group.defaultIndex} size={34} />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] font-semibold">{group.author}</span>
            <span class="text-[11px] text-fg-muted/70">{formatTime(group.items[0]?.timestamp ?? "")}</span>
          </div>
          {#each group.items as item (item.id)}
            {#if item.attachments?.length}
              <div class="mt-1 flex flex-wrap gap-1.5">
                {#each item.attachments as att (att.id + att.url)}
                  {#if isImage(att)}
                    <img src={att.url} alt={att.filename} class="max-h-64 rounded-lg border border-line/50 object-contain" />
                  {:else if isVideo(att)}
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video src={att.url} controls class="max-h-64 rounded-lg border border-line/50" aria-label={att.filename}></video>
                  {:else}
                    <a
                      href={att.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Открыть {att.filename}"
                      class="flex items-center gap-1.5 rounded-lg border border-line bg-panel-soft px-2.5 py-1.5 text-[12px] text-accent transition hover:bg-panel"
                    >
                      <svg viewBox="0 0 24 24" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                      <span class="max-w-40 truncate">{att.filename}</span>
                    </a>
                  {/if}
                {/each}
              </div>
            {/if}
            {#each item.embeds ?? [] as embed, i (item.id + "-e" + i)}
              {#if embed.image?.url}
                <img src={embed.image.url} alt={embed.title ?? "embed"} class="mt-1 max-h-64 rounded-lg border border-line/50 object-contain" />
              {:else if embed.title}
                <div class="mt-1 max-w-md rounded-lg border border-line bg-panel-soft px-3 py-2">
                  {#if embed.title}<p class="text-[13px] font-semibold">{embed.title}</p>{/if}
                  {#if embed.description}<p class="text-[12px] text-fg-muted">{embed.description}</p>{/if}
                </div>
              {/if}
            {/each}
            {#if item.content}
              <p class="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-fg/95">{item.content}</p>
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </div>

  <footer class="shrink-0 px-4 pb-4">
    {#if typingNames.length > 0}
      <p class="mb-1 text-[12px] text-fg-muted">{typingNames.join(", ")} {typingNames.length > 1 ? "печатают" : "печатает"}…</p>
    {/if}
    {#if sendError}
      <p class="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
        {sendError}
      </p>
    {/if}
    {#if gifOpen}
      <div class="mb-2 rounded-xl border border-line bg-panel p-3">
        <input
          value={gifQuery}
          oninput={(e) => {
            gifQuery = (e.currentTarget as HTMLInputElement).value;
            onGifInput();
          }}
          placeholder="Поиск гифок…"
          class="h-9 w-full rounded-lg border border-line bg-panel-soft px-3 text-[13px] text-fg outline-none placeholder:text-fg-muted/60 focus:border-accent"
        />
        {#if gifLoading}
          <p class="mt-2 text-[12px] text-fg-muted">Ищем…</p>
        {:else if gifError}
          <p class="mt-2 text-[12px] text-danger">{gifError}</p>
        {:else if gifs.length > 0}
          <div class="mt-2 grid max-h-48 grid-cols-4 gap-1.5 overflow-y-auto">
            {#each gifs as url (url)}
              <button type="button" onclick={() => pickGif(url)} class="overflow-hidden rounded-lg transition hover:opacity-80">
                <img src={url} alt="gif" class="h-20 w-full object-cover" />
              </button>
            {/each}
          </div>
        {:else if gifQuery.trim()}
          <p class="mt-2 text-[12px] text-fg-muted">Ничего не найдено</p>
        {/if}
      </div>
    {/if}
    <form onsubmit={submit} class="flex items-end gap-2">
      <button
        type="button"
        onclick={() => {
          gifOpen = !gifOpen;
          gifError = "";
        }}
        title="Гифки"
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-panel-soft text-[12px] font-bold text-fg-muted transition"
        class:text-accent={gifOpen}
      >
        GIF
      </button>
      <input
        bind:this={inputEl}
        name="message"
        placeholder="Написать сообщение…"
        bind:value={draft}
        oninput={onDraftInput}
        autocomplete="off"
        class="h-11 min-w-0 flex-1 rounded-xl border border-line bg-panel-soft px-3.5 text-[14px] text-fg transition outline-none placeholder:text-fg-muted/60 focus:border-accent"
      />
      <button
        type="submit"
        disabled={sending || !draft.trim()}
        title="Отправить"
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-ink transition hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-50"
      >
        {#if sending}
          <span class="text-[13px]">…</span>
        {:else}
          <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m22 2-7 20-4-9-9-4z" />
            <path d="M22 2 11 13" />
          </svg>
        {/if}
      </button>
    </form>
  </footer>
</div>
