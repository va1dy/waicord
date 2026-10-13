<script lang="ts">
  import TitleBar from "./components/TitleBar.svelte";
  import Login from "./pages/Login.svelte";
  import AppShell from "./components/AppShell.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import { app } from "./lib/app.svelte";
  import { contextMenu } from "./lib/contextMenu.svelte";
  import { copyText } from "./lib/clipboard";

  function onContextMenu(e: MouseEvent) {
    const handledByChild = e.defaultPrevented;
    e.preventDefault();
    if (handledByChild) return;

    const target = e.target as HTMLElement | null;
    const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (link) {
      const href = link.href;
      contextMenu.show(e, [
        { label: "Открыть", run: () => link.click() },
        { label: "Копировать ссылку", run: () => void copyText(href) },
      ]);
      return;
    }
    contextMenu.hide();
  }
</script>

<svelte:window oncontextmenu={onContextMenu} />

<div class="flex h-full min-h-0 flex-col">
  <TitleBar />
  <main class="min-h-0 flex-1">
    {#if !app.ready}
      <p class="grid h-full place-items-center text-[13px] text-fg-muted">Загрузка…</p>
    {:else if app.me}
      <AppShell />
    {:else}
      <Login />
    {/if}
  </main>
</div>

<ContextMenu />
