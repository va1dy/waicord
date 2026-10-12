<script lang="ts">
  let { compact = false }: { compact?: boolean } = $props();
</script>

<div class="flex items-center gap-2.5">
  <img src="/waicord.svg" alt="" class="size-9 rounded-[10px]" aria-hidden="true" />
  {#if !compact}
    <span class="font-display text-[17px] font-semibold tracking-tight">waicord</span>
  {/if}
</div>
