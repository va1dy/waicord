<script lang="ts">
  let {
    username,
    size = 32,
    url = null,
    defaultIndex = undefined,
  }: { username: string; size?: number; url?: string | null; defaultIndex?: number } = $props();

  const letter = $derived((username[0] ?? "?").toUpperCase());

  const hue = $derived.by(() => {
    let h = 0;
    for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 360;
    return h;
  });

  const bg = $derived(`hsl(${hue} 42% 40%)`);

  const src = $derived(
    url ??
      (defaultIndex !== undefined
        ? `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`
        : null),
  );
</script>

{#if src}
  <img
    {src}
    alt={username}
    decoding="async"
    class="inline-block shrink-0 rounded-full object-cover"
    style="width:{size}px;height:{size}px"
  />
{:else}
  <span
    class="inline-grid shrink-0 place-items-center rounded-full font-semibold text-white select-none"
    style="width:{size}px;height:{size}px;background:{bg};font-size:{Math.round(size * 0.42)}px"
    aria-hidden="true"
  >
    {letter}
  </span>
{/if}
