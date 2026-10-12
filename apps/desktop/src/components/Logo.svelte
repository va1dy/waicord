<script lang="ts">
  let { compact = false }: { compact?: boolean } = $props();
</script>

<div class="flex items-center gap-3">
  <img src="/waicord.svg" alt="" class="size-12 rounded-2xl" aria-hidden="true" />
  {#if !compact}
    <span class="font-display text-[24px] font-semibold tracking-tight">waicord</span>
  {/if}
</div>
