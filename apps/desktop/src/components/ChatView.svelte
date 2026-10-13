<script lang="ts">
  import { tick } from "svelte";
  import Avatar from "./Avatar.svelte";
  import { app } from "../lib/app.svelte";
  import { contextMenu, type MenuItem } from "../lib/contextMenu.svelte";
  import { copyText } from "../lib/clipboard";
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
    if (c.kind === "group") return { icon: "", label: c.name || "Группа" };
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
    const d = new Date(t);
    const now = new Date();
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return `Сегодня, ${time}`;
    if (sameDay(d, yest)) return `Вчера, ${time}`;
    if (d.getFullYear() === now.getFullYear())
      return `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}, ${time}`;
    return `${d.toLocaleDateString("ru-RU")}, ${time}`;
  }

  type Seg =
    | { kind: "text"; text: string }
    | { kind: "mention"; id: string }
    | { kind: "link"; url: string }
    | { kind: "image"; url: string }
    | { kind: "code"; text: string; block?: boolean }
    | { kind: "fmt"; fmt: "b" | "i" | "u" | "s" | "sp"; children: Seg[] };

  const IMAGE_HOSTS = [
    "giphy.com",
    "tenor.com",
    "klippy.com",
    "media.discordapp.net",
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "i.imgur.com",
    "imgur.com",
    "i.redd.it",
    "preview.redd.it",
  ];

  function isImageUrl(url: string): boolean {
    const clean = url.split(/[?#]/)[0] ?? url;
    if (/\.(gif|png|jpe?g|webp|avif|bmp)$/i.test(clean)) return true;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return IMAGE_HOSTS.some((h) => host === h || host.endsWith("." + h));
    } catch {
      return false;
    }
  }

  function onImgError(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    const wrap = img.parentElement;
    if (wrap) wrap.classList.add("img-failed");
  }

  function parseContent(content: string): Seg[] {
    const out: Seg[] = [];
    const cbRe = /```(?:\w+)?\n?([\s\S]*?)```/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = cbRe.exec(content)) !== null) {
      if (m.index > last) out.push(...parseInline(content.slice(last, m.index)));
      out.push({ kind: "code", text: (m[1] ?? "").replace(/\n$/, ""), block: true });
      last = m.index + m[0].length;
    }
    if (last < content.length) out.push(...parseInline(content.slice(last)));
    return out;
  }

  function parseInline(text: string): Seg[] {
    const segs: Seg[] = [];
    const icRe = /`([^`\n]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = icRe.exec(text)) !== null) {
      if (m.index > last) segs.push(...parseFmt(text.slice(last, m.index)));
      segs.push({ kind: "code", text: m[1] ?? "" });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push(...parseFmt(text.slice(last)));
    return segs;
  }

  function parseFmt(text: string): Seg[] {
    const segs: Seg[] = [];
    const re =
      /(\*\*|__|~~|\|\|)(.+?)\1|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|<@!?(\d+)>|(https?:\/\/[^\s<]+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) segs.push({ kind: "text", text: text.slice(last, m.index) });
      if (m[2] !== undefined) {
        const marker = m[1] ?? "";
        const fmt = marker === "**" ? "b" : marker === "__" ? "u" : marker === "~~" ? "s" : "sp";
        segs.push({ kind: "fmt", fmt, children: parseFmt(m[2]) });
      } else if (m[3] !== undefined) {
        segs.push({ kind: "fmt", fmt: "i", children: parseFmt(m[3]) });
      } else if (m[4] !== undefined) {
        segs.push({ kind: "fmt", fmt: "i", children: parseFmt(m[4]) });
      } else if (m[5] !== undefined) {
        segs.push({ kind: "mention", id: m[5] });
      } else if (m[6] !== undefined) {
        const url = m[6];
        segs.push(isImageUrl(url) ? { kind: "image", url } : { kind: "link", url });
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ kind: "text", text: text.slice(last) });
    return segs;
  }

  function onSpoiler(e: MouseEvent | KeyboardEvent) {
    (e.currentTarget as HTMLElement).classList.toggle("open");
  }

  function convertMentions(text: string): string {
    return text.replace(/@([\w.\u00C0-\u024F-]+)/g, (full, name: string) => {
      const u = app.findUserByName(name);
      return u ? `<@${u.id}>` : full;
    });
  }

  type Group = {
    authorId: string;
    author: string;
    avatarUrl: string | null;
    defaultIndex: number;
    id: string;
    items: MessageDTO[];
    system?: string;
  };

  function systemText(m: MessageDTO): string {
    const who = m.author.displayName || m.author.username;
    const target = m.content.replace(/<@!?\d+>/g, (s) => app.userLabel(s.replace(/[<@!>]/g, "")));
    switch (m.type) {
      case 1:
        return `${who} добавил(а) в группу ${target}`;
      case 2:
        return `${who} убрал(а) из группы ${target}`;
      case 3:
        return `${who} начал(а) звонок`;
      case 4:
        return `${who} изменил(а) название на «${m.content}»`;
      case 5:
        return `${who} изменил(а) иконку группы`;
      case 6:
        return `${who} закрепил(а) сообщение`;
      case 7:
        return `${who} присоединился(лась)`;
      default:
        return `${who} изменил(а) что-то`;
    }
  }

  function groupMessages(msgs: MessageDTO[]): Group[] {
    const out: Group[] = [];
    for (const m of msgs) {
      if (m.type !== 0) {
        out.push({
          authorId: "system",
          author: "",
          avatarUrl: null,
          defaultIndex: 0,
          id: m.id,
          items: [m],
          system: systemText(m),
        });
        continue;
      }
      const last = out[out.length - 1];
      if (last && !last.system && last.authorId === m.author.id) {
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

  function onMessageContext(e: MouseEvent, group: Group) {
    const link = (e.target as HTMLElement).closest?.("a[href]");
    if (link) return;
    e.preventDefault();

    const text = group.items
      .map((m) => m.content.trim())
      .filter(Boolean)
      .join("\n");
    const channelId = group.items[0]?.channelId ?? active;
    const messageLink = `https://discord.com/channels/${chat?.guildId ?? "@me"}/${channelId}/${group.id}`;
    const image = group.items.flatMap((m) => m.attachments ?? []).find((a) => isImage(a));

    const items: MenuItem[] = [];
    if (text) items.push({ label: "Копировать текст", run: () => void copyText(text) });
    items.push({ label: "Копировать ссылку на сообщение", run: () => void copyText(messageLink) });
    if (image) items.push({ label: "Копировать ссылку на картинку", run: () => void copyText(image.url) });
    contextMenu.show(e, items);
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (sending) return;
    const text = draft.trim();
    if (!text) return;
    sending = true;
    sendError = "";
    try {
      await app.sendMessage(convertMentions(text));
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
    {#if chat?.kind === "group"}
      <span class="flex shrink-0 items-center" aria-hidden="true">
        {#each chat.recipients.slice(0, 3) as u, i (u.id)}
          <span class="{i > 0 ? '-ml-2.5' : ''} rounded-full ring-2 ring-ink">
            <Avatar username={u.username} url={avatarOf(u)} defaultIndex={u.defaultAvatarIndex} size={20} />
          </span>
        {/each}
      </span>
      <h1 class="truncate text-[14px] font-semibold">{title.label}</h1>
      <span class="shrink-0 text-[12px] text-fg-muted">{chat.recipients.length + 1} участников</span>
    {:else}
      {#if title.icon}
        <span class="text-fg-muted" aria-hidden="true">{title.icon}</span>
      {/if}
      <h1 class="truncate text-[14px] font-semibold">{title.label}</h1>
    {/if}
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
    {#snippet segInline(seg: Seg)}
      {#if seg.kind === "text"}<span class="whitespace-pre-wrap">{seg.text}</span>
      {:else if seg.kind === "mention"}<span
          class="rounded-[3px] bg-accent/20 px-1 font-medium text-accent">{app.userLabel(seg.id)}</span
        >
      {:else if seg.kind === "link"}<a
          href={seg.url}
          target="_blank"
          rel="noreferrer"
          class="break-all text-accent hover:underline">{seg.url}</a
        >
      {:else if seg.kind === "code"}<code
          class="rounded-[3px] bg-panel-soft/80 px-1 font-mono text-[13px]">{seg.text}</code
        >
      {:else if seg.kind === "fmt"}
        {#if seg.fmt === "b"}<strong>{#each seg.children as c, ci (ci)}{@render segInline(c)}{/each}</strong>
        {:else if seg.fmt === "i"}<em>{#each seg.children as c, ci (ci)}{@render segInline(c)}{/each}</em>
        {:else if seg.fmt === "u"}<u>{#each seg.children as c, ci (ci)}{@render segInline(c)}{/each}</u>
        {:else if seg.fmt === "s"}<s>{#each seg.children as c, ci (ci)}{@render segInline(c)}{/each}</s>
        {:else if seg.fmt === "sp"}<span
            class="spoiler"
            role="button"
            tabindex="0"
            onclick={onSpoiler}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSpoiler(e);
            }}
            >{#each seg.children as c, ci (ci)}{@render segInline(c)}{/each}</span
          >
        {/if}
      {/if}
    {/snippet}
    {#if messages.length === 0}
      <p class="mt-8 text-center text-[13px] text-fg-muted">Сообщений пока нет — напиши первым.</p>
    {/if}
    {#each grouped as group (group.id)}
      {#if group.system}
        <p class="mt-2 pl-11 text-[12px] text-fg-muted/80 italic select-none">{group.system}</p>
      {:else}
      <div
        data-message
        role="article"
        oncontextmenu={(e) => onMessageContext(e, group)}
        class="mt-3 flex gap-3 first:mt-0 [content-visibility:auto] [contain-intrinsic-size:auto_140px]"
      >
        <Avatar username={group.author} url={group.avatarUrl} defaultIndex={group.defaultIndex} size={34} />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] font-semibold">{group.author}</span>
            <span class="text-[11px] text-fg-muted/70"
              >{formatTime(group.items[0]?.timestamp ?? "")}{#if group.items.some((m) => m.editedTimestamp)}
                <span class="text-fg-muted/50"> (изменено)</span>
              {/if}</span
            >
          </div>
          {#each group.items as item (item.id)}
            {#if item.attachments?.length}
              <div class="mt-1 flex flex-wrap gap-1.5">
                {#each item.attachments as att (att.id + att.url)}
                  {#if isImage(att)}
                    <img
                      src={att.url}
                      alt={att.filename}
                      loading="lazy"
                      decoding="async"
                      class="max-h-64 rounded-lg border border-line/50 object-contain"
                    />
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
              {@const embedImg = embed.image?.url || embed.thumbnail?.url}
              {#if embedImg}
                <span class="mt-1 inline-block">
                  <img
                    src={embedImg}
                    alt={embed.title ?? "превью"}
                    loading="lazy"
                    decoding="async"
                    onerror={onImgError}
                    class="max-h-80 rounded-lg border border-line/50 object-contain"
                  />
                  <a href={embedImg} target="_blank" rel="noreferrer" class="hidden text-accent hover:underline">{embedImg}</a>
                </span>
              {/if}
              {#if embed.title || embed.description}
                <div class="mt-1 max-w-md rounded-lg border border-line bg-panel-soft px-3 py-2">
                  {#if embed.url && embed.title}
                    <a href={embed.url} target="_blank" rel="noreferrer" class="text-[13px] font-semibold text-accent hover:underline">{embed.title}</a>
                  {:else if embed.title}
                    <p class="text-[13px] font-semibold">{embed.title}</p>
                  {/if}
                  {#if embed.description}
                    <p class="mt-0.5 text-[12px] text-fg-muted">{embed.description}</p>
                  {/if}
                </div>
              {/if}
            {/each}
            {#if item.content}
              {@const segs = parseContent(item.content)}
              {@const flow = segs.filter((s) => !(s.kind === "code" && s.block))}
              {#if flow.length > 0}
                <p class="text-[14px] leading-relaxed break-words text-fg/95">
                  {#each flow as seg, si (item.id + "-s" + si)}{@render segInline(seg)}{/each}
                </p>
              {/if}
              {#each segs.filter((s) => s.kind === "code" && s.block) as seg, si (item.id + "-cb" + si)}
                <pre
                  class="mt-1 max-w-full overflow-x-auto rounded-lg border border-line/50 bg-panel-soft px-3 py-2 font-mono text-[13px] text-fg/90"
                  >{#if seg.kind === "code"}{seg.text}{/if}</pre
                >
              {/each}
              {#each segs.filter((s) => s.kind === "image") as img, ii (item.id + "-img" + ii)}
                <span class="mt-1 inline-block">
                  <img
                    src={img.kind === "image" ? img.url : ""}
                    alt="изображение"
                    loading="lazy"
                    onerror={onImgError}
                    class="max-h-80 rounded-lg border border-line/50 object-contain"
                  />
                  {#if img.kind === "image"}
                    <a
                      href={img.url}
                      target="_blank"
                      rel="noreferrer"
                      class="hidden text-accent hover:underline"
                      >{img.url}</a
                    >
                  {/if}
                </span>
              {/each}
            {/if}
          {/each}
        </div>
      </div>
      {/if}
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
                <img src={url} alt="gif" loading="lazy" decoding="async" class="h-20 w-full object-cover" />
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
