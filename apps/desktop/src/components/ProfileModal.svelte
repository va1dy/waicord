<script lang="ts">
  import { tick } from "svelte";
  import Avatar from "./Avatar.svelte";
  import { app } from "../lib/app.svelte";

  const me = $derived(app.session?.user);

  let displayName = $state("");
  let status = $state("");
  let bio = $state("");
  let avatarUrl = $state<string | null>(null);
  let saving = $state(false);
  let error = $state("");
  let fileEl = $state<HTMLInputElement | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (app.profileOpen && me) {
      displayName = me.display_name ?? "";
      status = me.status ?? "";
      bio = me.bio ?? "";
      avatarUrl = me.avatar_url ?? null;
      error = "";
      void tick().then(() => nameInput?.focus());
    }
  });

  $effect(() => {
    if (!app.profileOpen) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") app.profileOpen = false;
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });

  function onAvatarFile(file: File) {
    error = "";
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 300;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        error = "Не удалось обработать изображение";
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const data = canvas.toDataURL("image/jpeg", 0.85);
      if (data.length > 400_000) {
        error = "Картинка слишком большая — выбери поменьше";
        URL.revokeObjectURL(url);
        return;
      }
      avatarUrl = data;
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      error = "Не удалось прочитать изображение";
    };
    img.src = url;
  }

  async function save(event: Event) {
    event.preventDefault();
    if (saving) return;
    saving = true;
    error = "";
    try {
      await app.updateProfile({
        display_name: displayName.trim(),
        status: status.trim(),
        bio: bio.trim(),
        avatar_url: avatarUrl,
      });
      app.profileOpen = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Не удалось сохранить";
    } finally {
      saving = false;
    }
  }
</script>

{#if app.profileOpen && me}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) app.profileOpen = false; }}>
    <div class="w-full max-w-sm rounded-2xl border border-line bg-panel p-5 shadow-2xl" role="dialog" aria-modal="true" aria-label="Настройки профиля">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-[15px] font-semibold">Профиль</h2>
        <button type="button" onclick={() => (app.profileOpen = false)} class="grid size-7 place-items-center rounded-lg text-fg-muted transition hover:bg-panel-soft hover:text-fg" aria-label="Закрыть">
          <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div class="mb-4 flex items-center gap-3">
        <Avatar username={me.username} url={avatarUrl} size={56} />
        <div class="flex flex-col gap-1">
          <input bind:this={fileEl} type="file" accept="image/*" class="hidden" onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) onAvatarFile(f); (e.currentTarget as HTMLInputElement).value = ""; }} />
          <button type="button" onclick={() => fileEl?.click()} class="h-8 rounded-lg border border-line bg-panel-soft px-3 text-[12px] font-medium text-fg transition hover:bg-panel">
            Сменить аватар
          </button>
          {#if avatarUrl}
            <button type="button" onclick={() => (avatarUrl = null)} class="h-7 text-[11px] text-fg-muted transition hover:text-danger">
              Убрать аватар
            </button>
          {/if}
        </div>
      </div>

      {#if error}
        <p class="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>
      {/if}

      <form onsubmit={save} class="flex flex-col gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-medium text-fg-muted">Отображаемое имя</span>
          <input bind:this={nameInput} bind:value={displayName} maxlength="40" placeholder={me.username} class="h-9 rounded-lg border border-line bg-panel-soft px-3 text-[13px] text-fg outline-none focus:border-accent" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-medium text-fg-muted">Статус</span>
          <input bind:value={status} maxlength="60" placeholder="В сети" class="h-9 rounded-lg border border-line bg-panel-soft px-3 text-[13px] text-fg outline-none focus:border-accent" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-medium text-fg-muted">О себе</span>
          <textarea bind:value={bio} maxlength="400" rows="3" placeholder="Пара слов о себе" class="resize-none rounded-lg border border-line bg-panel-soft px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"></textarea>
        </label>
        <p class="truncate text-[11px] text-fg-muted">@{me.username}</p>
        <div class="mt-1 flex justify-end gap-2">
          <button type="button" onclick={() => (app.profileOpen = false)} class="h-9 rounded-lg px-3 text-[13px] text-fg-muted transition hover:text-fg">
            Отмена
          </button>
          <button type="submit" disabled={saving} class="h-9 rounded-lg bg-accent px-4 text-[13px] font-semibold text-ink transition hover:bg-accent-strong disabled:opacity-50">
            {saving ? "…" : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
