<script lang="ts">
  import { onMount } from "svelte";
  import Button from "../components/ui/Button.svelte";
  import Field from "../components/ui/Field.svelte";
  import { login } from "../lib/api";

  let identifier = $state("");
  let password = $state("");
  let identifierError = $state("");
  let passwordError = $state("");
  let formError = $state("");
  let loading = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    identifierError = identifier.trim() ? "" : "Введите логин или email";
    passwordError = password ? "" : "Введите пароль";
    formError = "";
    if (identifierError || passwordError) {
      const firstInvalid = identifierError ? "identifier" : "password";
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`input[name=${firstInvalid}]`)?.focus());
      return;
    }

    loading = true;
    try {
      await login(identifier.trim(), password);
    } catch (error) {
      formError = error instanceof Error ? error.message : "Не удалось войти";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    const bg = document.getElementById("bg");
    const glow1 = document.getElementById("glow-1");
    const glow2 = document.getElementById("glow-2");
    if (!bg || !glow1 || !glow2) return;

    let tx = window.innerWidth / 2;
    let ty = window.innerHeight / 2;
    let x = tx;
    let y = ty;
    let x2 = tx;
    let y2 = ty;

    const paint = () => {
      glow1.style.transform = `translate3d(${x - 210}px, ${y - 210}px, 0)`;
      glow2.style.transform = `translate3d(${x2 - 280}px, ${y2 - 280}px, 0)`;
      bg.style.setProperty("--mx", `${x}px`);
      bg.style.setProperty("--my", `${y}px`);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint();
      return;
    }

    const onMove = (event: PointerEvent) => {
      tx = event.clientX;
      ty = event.clientY;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let raf = 0;
    const tick = () => {
      x += (tx - x) * 0.09;
      y += (ty - y) * 0.09;
      x2 += (tx - x2) * 0.035;
      y2 += (ty - y2) * 0.035;
      paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  });
</script>

<div class="relative h-full min-h-0 overflow-y-auto">
  <div id="bg" class="pointer-events-none fixed inset-0" style="--mx: 50vw; --my: 50vh">
    <div
      class="absolute inset-0 [background-image:linear-gradient(rgba(232,236,244,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(232,236,244,0.04)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(130%_110%_at_50%_35%,black_10%,transparent_75%)]"
    ></div>
    <div
      class="absolute inset-0 [background-image:linear-gradient(rgba(232,236,244,0.13)_1px,transparent_1px),linear-gradient(90deg,rgba(232,236,244,0.13)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(240px_at_var(--mx)_var(--my),black,transparent_75%)]"
    ></div>
    <div
      id="glow-1"
      class="absolute top-0 left-0 size-[420px] rounded-full bg-accent/15 blur-[120px]"
      style="transform: translate3d(calc(50vw - 210px), calc(50vh - 210px), 0)"
    ></div>
    <div
      id="glow-2"
      class="absolute top-0 left-0 size-[560px] rounded-full bg-accent-deep/10 blur-[160px]"
      style="transform: translate3d(calc(50vw - 280px), calc(50vh - 280px), 0)"
    ></div>
  </div>

  <div class="relative z-10 flex min-h-full items-center justify-center p-6">
    <div
      class="rise w-full max-w-[376px] rounded-2xl border border-line/60 bg-panel/40 p-8 text-center shadow-[0_30px_70px_-40px_rgb(0_0_0_0.9)] backdrop-blur-xl"
      style="animation-delay: 100ms"
    >
    <img src="/waicord.svg" alt="" class="mx-auto size-14" aria-hidden="true" />
    <h2 class="mt-5 font-display text-[26px] font-semibold tracking-tight">Sign in to waicord</h2>
    <p class="mt-1.5 text-sm text-fg-muted">Welcome back.</p>

    <form class="mt-7 space-y-4 text-left" onsubmit={submit}>
      <Field
        name="identifier"
        label="Логин или email"
        placeholder="you@example.com"
        autocomplete="username"
        bind:value={identifier}
        error={identifierError}
      />
      <Field
        name="password"
        label="Пароль"
        type="password"
        autocomplete="current-password"
        bind:value={password}
        error={passwordError}
      />

      <div class="flex items-center justify-between text-[13px]">
        <label class="flex cursor-pointer select-none items-center gap-2 text-fg-muted">
          <input type="checkbox" class="size-4 rounded" style="accent-color: var(--color-accent)" />
          Запомнить меня
        </label>
        <button
          type="button"
          disabled
          class="text-fg-muted/70 transition hover:text-fg-muted disabled:cursor-not-allowed"
          title="Появится после подключения API"
        >
          Забыли пароль?
        </button>
      </div>

      {#if formError}
        <p class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-center text-[13px] leading-snug text-danger">
          {formError}
        </p>
      {/if}

      <Button type="submit" loading={loading}>Войти</Button>
    </form>

    <div class="my-5 flex items-center gap-3 text-xs text-fg-muted">
      <span class="h-px flex-1 bg-line"></span>
      <span>или</span>
      <span class="h-px flex-1 bg-line"></span>
    </div>

    <Button variant="outline" disabled title="Появится после подключения API">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <path d="M14 14h3v3h-3z" />
        <path d="M20 14h1v1h-1z" />
        <path d="M14 20h1v1h-1z" />
        <path d="M18 18h3v3h-3z" />
      </svg>
      Войти по QR-коду
      <span class="ml-1 rounded-full bg-line px-2 py-0.5 text-[10px] font-medium text-fg-muted">скоро</span>
    </Button>

    <p class="mt-6 text-center text-[13px] text-fg-muted">
      Нет аккаунта?
      <button
        type="button"
        disabled
        class="ml-1 font-medium text-accent disabled:cursor-not-allowed disabled:text-fg-muted"
        title="Появится после подключения API"
      >
        Создать аккаунт
      </button>
    </p>
    </div>
  </div>
</div>

<style>
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .rise {
    animation: rise 0.6s cubic-bezier(0.22, 0.7, 0.2, 1) both;
  }
</style>
