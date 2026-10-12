<script lang="ts">
  import type { FullAutoFill } from "svelte/elements";

  let {
    label,
    name,
    type = "text",
    value = $bindable(""),
    placeholder = "",
    autocomplete = "",
    error = "",
  }: {
    label: string;
    name: string;
    type?: string;
    value?: string;
    placeholder?: string;
    autocomplete?: FullAutoFill | null;
    error?: string;
  } = $props();

  let visible = $state(false);
  const isPassword = $derived(type === "password");
  const inputType = $derived(isPassword && visible ? "text" : type);
</script>

<label class="block">
  <span class="mb-1.5 block text-[13px] font-medium text-fg-muted">{label}</span>
  <div class="relative">
    <input
      {name}
      type={inputType}
      {placeholder}
      {autocomplete}
      bind:value
      aria-invalid={error ? "true" : undefined}
      class="h-11 w-full rounded-xl border bg-panel-soft px-3.5 text-[15px] text-fg transition outline-none placeholder:text-fg-muted/60 {isPassword
        ? 'pr-11'
        : ''} {error ? 'border-danger' : 'border-line focus:border-accent'}"
    />
    {#if isPassword}
      <button
        type="button"
        class="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-fg-muted transition hover:text-fg"
        aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
        onclick={() => (visible = !visible)}
      >
        {#if visible}
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c5.10 0 8.94 3.35 10.31 7-.47 1.26-1.17 2.4-2.07 3.36" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            <path d="M6.63 6.63C4.15 8.1 2.5 10 2 12c1.5 3.5 5.4 7 10 7 1.6 0 3.1-.3 4.4-.9" />
            <path d="m2 2 20 20" />
          </svg>
        {:else}
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        {/if}
      </button>
    {/if}
  </div>
  {#if error}
    <p class="mt-1.5 text-xs text-danger">{error}</p>
  {/if}
</label>
