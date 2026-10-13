<script lang="ts">
  import TitleBar from "./components/TitleBar.svelte";
  import Login from "./pages/Login.svelte";
  import AppShell from "./components/AppShell.svelte";
  import { app } from "./lib/app.svelte";
</script>

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
