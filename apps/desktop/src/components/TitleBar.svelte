<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";

  let win: TauriWindow | null = null;
  try {
    win = getCurrentWindow();
  } catch {
    win = null;
  }

  let maximized = $state(false);

  onMount(() => {
    if (!win) return;
    const w = win;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    w.isMaximized()
      .then((m) => (maximized = m))
      .catch(() => {});
    w.onResized(async () => {
      try {
        maximized = await w.isMaximized();
      } catch {
        /* noop */
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  });

  function minimize() {
    win?.minimize().catch(() => {});
  }
  function toggleMaximize() {
    win?.toggleMaximize().catch(() => {});
  }
  function close() {
    win?.close().catch(() => {});
  }
</script>

<header
  data-tauri-drag-region
  class="relative z-50 flex h-10 shrink-0 items-center justify-between border-b border-line bg-panel/80 pl-3 select-none"
>
  <div data-tauri-drag-region class="flex items-center gap-2">
    <img src="/waicord-mark.svg" alt="" class="size-4" aria-hidden="true" />
    <span class="text-[13px] font-semibold tracking-tight text-fg">waicord</span>
  </div>

  <div class="flex h-full items-center">
    <button
      type="button"
      onclick={minimize}
      class="grid h-full w-[46px] place-items-center text-fg-muted transition hover:bg-white/5 hover:text-fg"
      title="Свернуть"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
        <path d="M0.5 5h9" stroke-linecap="round" />
      </svg>
    </button>
    <button
      type="button"
      onclick={toggleMaximize}
      class="grid h-full w-[46px] place-items-center text-fg-muted transition hover:bg-white/5 hover:text-fg"
      title={maximized ? "Восстановить" : "Развернуть"}
    >
      {#if maximized}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
          <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
          <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
        </svg>
      {:else}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">
          <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
        </svg>
      {/if}
    </button>
    <button
      type="button"
      onclick={close}
      class="grid h-full w-[46px] place-items-center text-fg-muted transition hover:bg-[#c43c3c] hover:text-white"
      title="Закрыть"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true">
        <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
      </svg>
    </button>
  </div>
</header>
