<script lang="ts">
  import Logo from "../components/Logo.svelte";
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
</script>

<div class="grid h-full min-w-0 min-[900px]:grid-cols-[1.15fr_1fr]">
  <section class="relative hidden overflow-hidden min-[900px]:flex">
    <div
      class="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgba(232,236,244,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(232,236,244,0.045)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(120%_100%_at_15%_20%,black_10%,transparent_75%)]"
    ></div>
    <div class="pointer-events-none absolute -bottom-32 -left-24 size-[440px] rounded-full bg-accent/15 blur-[140px]"></div>
    <div class="pointer-events-none absolute -top-28 right-[-60px] size-[320px] rounded-full bg-accent-deep/10 blur-[130px]"></div>

    <div class="relative z-10 flex w-full flex-col p-12">
      <Logo />
      <div class="mt-auto max-w-[520px] pb-2">
        <h1
          class="rise font-display text-[52px] font-semibold leading-[1.04] tracking-tight"
          style="animation-delay: 60ms"
        >
          Общение без лишнего веса
        </h1>
        <p class="rise mt-5 max-w-[46ch] text-[16px] leading-relaxed text-fg-muted" style="animation-delay: 160ms">
          Серверы, каналы и голос в клиенте, который открывается мгновенно и почти не ест память.
        </p>
      </div>
    </div>
  </section>

  <section
    class="relative flex overflow-y-auto p-6 [background:radial-gradient(640px_320px_at_50%_-10%,rgba(255,180,84,0.07),transparent_70%)]"
  >
    <div
      class="rise m-auto w-full max-w-[384px] rounded-2xl border border-line/80 bg-panel/70 p-7 shadow-[0_30px_70px_-40px_rgb(0_0_0_0.9)] backdrop-blur-sm"
      style="animation-delay: 100ms"
    >
      <h2 class="font-display text-[26px] font-semibold tracking-tight">Вход в аккаунт</h2>
      <p class="mt-1 text-sm text-fg-muted">Рады видеть снова.</p>

      <form class="mt-6 space-y-4" onsubmit={submit}>
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
          <p class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] leading-snug text-danger">
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

      <Button variant="soft" disabled title="Появится после подключения API">
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
  </section>
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
