<script lang="ts">
  import { contextMenu } from "../lib/contextMenu.svelte";

  let el = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);

  $effect(() => {
    if (!contextMenu.open) return;
    const { x, y } = contextMenu.anchor;
    left = x;
    top = y;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 140;
    left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  });

  $effect(() => {
    if (!contextMenu.open) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      contextMenu.hide();
    };
    const onScroll = () => contextMenu.hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") contextMenu.hide();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("wheel", onScroll, { capture: true, passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onScroll);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onScroll);
    };
  });
</script>

{#if contextMenu.open}
  <div
    bind:this={el}
    role="menu"
    aria-label="Действия"
    style="left:{left}px;top:{top}px"
    class="ctx-menu fixed z-[100] min-w-48 rounded-xl border border-line/80 bg-panel/95 p-1.5 shadow-2xl backdrop-blur-xl"
  >
    {#each contextMenu.items as item, i (i)}
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        onclick={() => contextMenu.select(item)}
        class="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg/90 transition hover:bg-panel-soft hover:text-fg disabled:pointer-events-none disabled:opacity-40"
      >
        <span class="truncate">{item.label}</span>
        {#if item.hint}
          <span class="ml-auto shrink-0 text-[11px] text-fg-muted/70">{item.hint}</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
