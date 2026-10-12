<script lang="ts">
  import TitleBar from "./components/TitleBar.svelte";
  import Login from "./pages/Login.svelte";
  import AppShell from "./components/AppShell.svelte";
  import { app } from "./lib/app.svelte";
</script>

<div class="flex h-full min-h-0 flex-col">
  <TitleBar />
  <main class="min-h-0 flex-1">
    {#if app.session}
      <AppShell />
    {:else}
      <Login />
    {/if}
  </main>
</div>
