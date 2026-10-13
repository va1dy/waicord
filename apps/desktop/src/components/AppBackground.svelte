<script lang="ts">
  import GlowCanvas from "./GlowCanvas.svelte";
</script>

<div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
  <GlowCanvas />
  <div class="bg-grid absolute inset-0"></div>
</div>
