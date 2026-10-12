<script lang="ts">
  import type { Snippet } from "svelte";

  type Variant = "primary" | "soft" | "outline" | "ghost";

  let {
    type = "button",
    variant = "primary",
    loading = false,
    disabled = false,
    title = undefined,
    class: klass = "",
    children,
    onclick,
  }: {
    type?: "button" | "submit";
    variant?: Variant;
    loading?: boolean;
    disabled?: boolean;
    title?: string;
    class?: string;
    children?: Snippet;
    onclick?: (event: MouseEvent) => void;
  } = $props();

  const base =
    "relative flex h-9 w-full items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-medium transition outline-none disabled:pointer-events-none disabled:opacity-50 active:translate-y-px";

  const variants: Record<Variant, string> = {
    primary:
      "bg-accent text-ink font-semibold hover:bg-accent-strong shadow-[0_10px_26px_-16px_rgba(255,180,84,0.7)]",
    soft: "border border-line bg-panel-soft text-fg hover:border-accent/40 hover:bg-panel",
    outline: "border border-line bg-transparent text-fg hover:border-accent/50 hover:bg-panel-soft/60",
    ghost: "text-fg-muted hover:text-fg",
  };
</script>

<button {type} {disabled} {title} {onclick} class="{base} {variants[variant]} {klass}">
  {#if loading}
    <svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25" stroke-width="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
    </svg>
  {:else}
    {@render children?.()}
  {/if}
</button>
