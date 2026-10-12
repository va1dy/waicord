<script lang="ts">
  let { compact = false }: { compact?: boolean } = $props();
</script>

<div class="flex items-center gap-2.5">
  <span
    class="grid size-9 place-items-center rounded-xl bg-[linear-gradient(135deg,var(--color-accent),var(--color-accent-deep))] font-display text-lg font-bold text-ink"
    aria-hidden="true"
  >
    w
  </span>
  {#if !compact}
    <span class="font-display text-[17px] font-semibold tracking-tight">waicord</span>
  {/if}
</div>
