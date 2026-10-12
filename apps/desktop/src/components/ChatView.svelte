<script lang="ts">
  import { tick } from "svelte";
  import Avatar from "./Avatar.svelte";
  import { app } from "../lib/app.svelte";
  import { call } from "../lib/call.svelte";
  import {
    attName,
    attUrl,
    resolveAttUrl,
    searchGifs,
    uploadFile,
    type Attachment,
    type Message,
  } from "../lib/api";

  const active = $derived(app.active);
  const meId = $derived(app.session?.user.id ?? "");

  const dmConv = $derived(active.kind === "dm" ? app.dms.find((d) => d.id === active.id) : undefined);
  const dmPeer = $derived(
    dmConv && dmConv.kind === "dm" ? (dmConv.members.find((m) => m.id !== meId) ?? dmConv.members[0]) : undefined,
  );

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
      const other = conv.members.find((m) => m.id !== meId) ?? conv.members[0];
      return { icon: "@", label: other?.display_name || other?.username || "чат" };
    }
    return { icon: "", label: "" };
  });

  const canCall = $derived(dmConv?.kind === "dm" && !!dmPeer);

  const key = $derived(app.viewKey());
  const messages = $derived((key && app.messages[key]) || ([] as Message[]));

  let draft = $state("");
  let attachments = $state<{ url: string; name: string }[]>([]);
  let uploading = $state(false);
  let sendError = $state("");
  let listEl = $state<HTMLElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let fileEl = $state<HTMLInputElement | null>(null);

  let gifOpen = $state(false);
  let gifQuery = $state("");
  let gifs = $state<string[]>([]);
  let gifLoading = $state(false);
  let gifError = $state("");
  let gifTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    void messages.length;
    void key;
    tick().then(() => {
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    });
  });

  $effect(() => {
    void key;
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
    attachments = [];
    gifOpen = false;
    gifQuery = "";
    gifs = [];
    gifError = "";
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (app.profileOpen || call.phase !== "idle") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    inputEl?.focus();
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  type Group = { authorId: string; author: string; avatarUrl: string | null; id: string; items: Message[] };

  function groupMessages(msgs: Message[]): Group[] {
    const out: Group[] = [];
    for (const m of msgs) {
      const last = out[out.length - 1];
      if (last && last.authorId === m.user.id) {
        last.items.push(m);
      } else {
        out.push({
          authorId: m.user.id,
          author: m.user.display_name || m.user.username,
          avatarUrl: m.user.avatar_url ?? null,
          id: m.id,
          items: [m],
        });
      }
    }
    return out;
  }

  const grouped = $derived(groupMessages(messages));

  async function addFiles(files: FileList | File[]) {
    uploading = true;
    sendError = "";
    try {
      for (const file of Array.from(files).slice(0, 4)) {
        const uploaded = await uploadFile(app.base, app.token, file);
        attachments = [...attachments, { url: uploaded.url, name: uploaded.name }];
      }
    } catch (error) {
      sendError = error instanceof Error ? error.message : "Не удалось загрузить файл";
    } finally {
      uploading = false;
    }
  }

  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index);
  }

  function pickGif(url: string) {
    attachments = [...attachments, { url, name: "giphy.gif" }];
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

  async function submit(event: Event) {
    event.preventDefault();
    if (sending) return;
    const text = draft.trim();
    const files = attachments;
    if (!text && files.length === 0) return;
    uploading = true;
    sendError = "";
    try {
      await app.sendMessage(
        text,
        files.map((f): Attachment => ({ url: f.url, name: f.name })),
      );
      resetComposer();
      focusInput();
    } catch (error) {
      sendError = error instanceof Error ? error.message : "Не удалось отправить";
    } finally {
      uploading = false;
    }
  }

  function startCall() {
    if (!dmPeer || !dmConv) return;
    void call.start(dmConv.id, dmPeer.id, dmPeer.display_name || dmPeer.username, dmPeer.avatar_url ?? null);
  }

  const sending = $derived(uploading);
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line/60 px-4">
    <span class="text-fg-muted" aria-hidden="true">{title.icon}</span>
    <h1 class="truncate text-[14px] font-semibold">{title.label}</h1>
    {#if active.kind === "dm" && dmConv && dmConv.kind === "dm" && dmPeer}
      <span class="flex items-center gap-1.5 text-[12px] text-fg-muted">
        <span
          class="inline-block size-2 rounded-full {dmPeer.online ? 'bg-[#3ba55d]' : 'bg-fg-muted/40'}"
          aria-hidden="true"
        ></span>
        {dmPeer.online ? "в сети" : "не в сети"}
      </span>
      <button
        type="button"
        onclick={startCall}
        title="Начать звонок"
        class="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition hover:bg-panel-soft hover:text-fg"
      >
        <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      </button>
    {/if}
  </header>

  <div bind:this={listEl} class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
    {#if messages.length === 0}
      <p class="mt-8 text-center text-[13px] text-fg-muted">Сообщений пока нет — напиши первым.</p>
    {/if}
    {#each grouped as group (group.id)}
      <div class="mt-3 flex gap-3 first:mt-0">
        <Avatar username={group.author} url={group.avatarUrl} size={34} />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] font-semibold">{group.author}</span>
            <span class="text-[11px] text-fg-muted/70">{formatTime(group.items[0]?.created_at ?? 0)}</span>
          </div>
          {#each group.items as item (item.id)}
            {#if item.attachments?.length}
              <div class="mt-1 flex flex-wrap gap-1.5">
                {#each item.attachments as att (attUrl(att))}
                  {@const url = resolveAttUrl(att, app.base)}
                  {@const name = attName(att)}
                  {#if name.endsWith(".gif") || attUrl(att).includes("giphy")}
                    <img src={url} alt="gif" class="max-h-40 rounded-lg border border-line/50 object-contain" />
                  {:else if name.match(/\.(png|jpe?g|webp|avif|svg)$/i)}
                    <img src={url} alt={name} class="max-h-64 rounded-lg border border-line/50 object-contain" />
                  {:else if name.match(/\.(webm|mp4|mov)$/i)}
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video src={url} controls class="max-h-64 rounded-lg border border-line/50" aria-label={name}></video>
                  {:else}
                    <a
                      href={url}
                      download={name}
                      target="_blank"
                      rel="noreferrer"
                      title="Скачать {name}"
                      class="flex items-center gap-1.5 rounded-lg border border-line bg-panel-soft px-2.5 py-1.5 text-[12px] text-accent transition hover:bg-panel"
                    >
                      <svg viewBox="0 0 24 24" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                      <span class="max-w-40 truncate">{name}</span>
                    </a>
                  {/if}
                {/each}
              </div>
            {/if}
            {#if item.content}
              <p class="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-fg/95">{item.content}</p>
            {/if}
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
    {#if attachments.length > 0}
      <div class="mb-2 flex flex-wrap gap-1.5">
        {#each attachments as att, i (att.url)}
          <span class="flex items-center gap-1.5 rounded-lg border border-line bg-panel-soft px-2 py-1 text-[12px] text-fg-muted">
            {#if att.url.includes("giphy") || att.url.endsWith(".gif")}
              gif
            {:else}
              {att.name.length > 18 ? att.name.slice(0, 15) + "…" : att.name}
            {/if}
            <button type="button" onclick={() => removeAttachment(i)} class="text-fg-muted transition hover:text-danger" aria-label="Убрать вложение">
              <svg viewBox="0 0 24 24" class="size-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </span>
        {/each}
      </div>
    {/if}
    <form onsubmit={submit} onpaste={onPaste} class="flex items-end gap-2">
      <input bind:this={fileEl} type="file" multiple accept="image/*,video/*,.gif,.pdf,.zip,.txt" class="hidden" onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files; if (f?.length) void addFiles(f); (e.currentTarget as HTMLInputElement).value = ""; }} />
      <button
        type="button"
        onclick={() => fileEl?.click()}
        title="Прикрепить файл"
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-panel-soft text-fg-muted transition hover:text-fg"
      >
        <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
      </button>
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
        autocomplete="off"
        class="h-11 min-w-0 flex-1 rounded-xl border border-line bg-panel-soft px-3.5 text-[14px] text-fg transition outline-none placeholder:text-fg-muted/60 focus:border-accent"
      />
      <button
        type="submit"
        disabled={sending || (!draft.trim() && attachments.length === 0)}
        title="Отправить"
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-ink transition hover:bg-accent-strong disabled:pointer-events-none disabled:opacity-50"
      >
        {#if uploading}
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
