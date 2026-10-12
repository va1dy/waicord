<script lang="ts">
  import Button from "../components/ui/Button.svelte";
  import Field from "../components/ui/Field.svelte";
  import GlowCanvas from "../components/GlowCanvas.svelte";
  import { health, login, me, normalizeServer, register, type Session } from "../lib/api";
  import { app } from "../lib/app.svelte";

  type Mode = "waicord" | "discord";

  let mode = $state<Mode>(
    typeof localStorage !== "undefined" && localStorage.getItem("waicord.mode") === "discord" ? "discord" : "waicord",
  );

  let waicordStep = $state<"connect" | "account">("connect");
  let accountView = $state<"login" | "register">("login");
  let pendingServer = $state("");

  let serverInput = $state("");
  let tokenInput = $state("");
  let serverError = $state("");
  let connecting = $state(false);

  let identifier = $state("");
  let password = $state("");
  let identifierError = $state("");
  let passwordError = $state("");
  let formError = $state("");
  let loading = $state(false);

  let regUsername = $state("");
  let regEmail = $state("");
  let regPassword = $state("");
  let regError = $state("");

  function switchMode(next: Mode) {
    if (mode === next) return;
    mode = next;
    waicordStep = "connect";
    formError = "";
    serverError = "";
    try {
      localStorage.setItem("waicord.mode", next);
    } catch {
      /* noop */
    }
  }

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    serverError = "";
    const base = normalizeServer(serverInput);
    if (!base) {
      serverError = "Укажи адрес сервера";
      return;
    }
    connecting = true;
    try {
      await health(base);
      const token = tokenInput.trim();
      if (token) {
        try {
          const { user } = await me(base, token);
          const next: Session = { server: base, token, user };
          await app.loginWith(next);
          return;
        } catch {
          /* токен не подошёл — идём по логину/паролю */
        }
      }
      pendingServer = base;
      waicordStep = "account";
      accountView = "login";
    } catch (error) {
      serverError = error instanceof Error ? error.message : "Сервер недоступен";
    } finally {
      connecting = false;
    }
  }

  async function submitAccount(event: SubmitEvent) {
    event.preventDefault();
    identifierError = identifier.trim() ? "" : "Введите логин или email";
    passwordError = password ? "" : "Введите пароль";
    formError = "";
    if (identifierError || passwordError) return;

    loading = true;
    try {
      const { token, user } = await login(pendingServer, identifier.trim(), password);
      const next: Session = { server: pendingServer, token, user };
      await app.loginWith(next);
    } catch (error) {
      formError = error instanceof Error ? error.message : "Не удалось войти";
    } finally {
      loading = false;
    }
  }

  async function submitRegister(event: SubmitEvent) {
    event.preventDefault();
    regError = "";
    loading = true;
    try {
      const { token, user } = await register(pendingServer, regUsername.trim(), regEmail.trim(), regPassword);
      const next: Session = { server: pendingServer, token, user };
      await app.loginWith(next);
    } catch (error) {
      regError = error instanceof Error ? error.message : "Не удалось зарегистрироваться";
    } finally {
      loading = false;
    }
  }

  function submitDiscord(event: SubmitEvent) {
    event.preventDefault();
    formError = "Вход в Discord появится после подключения";
  }
</script>

<div class="relative h-full min-h-0 overflow-y-auto">
  <div id="bg" class="pointer-events-none fixed inset-0">
    <GlowCanvas />
    <div
      class="absolute inset-0 [background-image:linear-gradient(rgba(232,236,244,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(232,236,244,0.04)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(130%_110%_at_50%_35%,black_10%,transparent_75%)]"
    ></div>
  </div>

  <div class="relative z-10 flex min-h-full items-center justify-center p-6">
    <div
      class="rise w-full max-w-[376px] rounded-2xl border border-line/60 bg-panel/40 p-8 text-center shadow-[0_30px_70px_-40px_rgb(0_0_0_0.9)] backdrop-blur-xl"
      style="animation-delay: 100ms"
    >
      <div class="mx-auto mb-7 flex w-full rounded-xl border border-line/60 bg-panel-soft/50 p-1 text-[13px] font-medium">
        <button
          type="button"
          onclick={() => switchMode("waicord")}
          class="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg transition {mode === 'waicord'
            ? 'bg-panel text-fg shadow-sm'
            : 'text-fg-muted hover:text-fg'}"
        >
          <img src="/waicord-mark.svg" class="size-4" alt="" aria-hidden="true" />
          waicord
        </button>
        <button
          type="button"
          onclick={() => switchMode("discord")}
          class="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg transition {mode === 'discord'
            ? 'bg-panel text-fg shadow-sm'
            : 'text-fg-muted hover:text-fg'}"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            class={mode === "discord" ? "text-[#5865f2]" : "text-fg-muted/70"}
            aria-hidden="true"
          >
            <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
          </svg>
          discord
        </button>
      </div>

      {#if mode === "discord"}
        <svg width="44" height="44" viewBox="0 0 24 24" fill="#5865f2" class="mx-auto" aria-hidden="true">
          <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
        </svg>
        <h2 class="mt-5 font-display text-[26px] font-semibold tracking-tight">Вход в Discord</h2>
        <p class="mt-1.5 text-sm text-fg-muted">Твой аккаунт Discord — ник или почта + пароль.</p>

        <form class="mt-7 space-y-4 text-left" onsubmit={submitDiscord}>
          <Field name="discord-id" label="Логин или email" placeholder="you@example.com" autocomplete="username" bind:value={identifier} />
          <Field name="discord-pass" label="Пароль" type="password" autocomplete="current-password" bind:value={password} />

          {#if formError}
            <p class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-center text-[13px] leading-snug text-danger">
              {formError}
            </p>
          {/if}

          <Button type="submit">Войти</Button>
        </form>

        <p class="mt-5 text-[13px] leading-relaxed text-fg-muted">
          Серверы, друзья и каналы из Discord — в одном клиенте.
        </p>
      {:else if waicordStep === "connect"}
        <img src="/waicord.svg" alt="" class="mx-auto size-14" aria-hidden="true" />
        <h2 class="mt-5 font-display text-[26px] font-semibold tracking-tight">Подключиться к серверу</h2>
        <p class="mt-1.5 text-sm text-fg-muted">Свой open-source сервер или публичный.</p>

        <form class="mt-7 space-y-4 text-left" onsubmit={connect}>
          <Field
            name="server"
            label="Сервер"
            placeholder="ip:порт или server.example.com"
            autocomplete="off"
            bind:value={serverInput}
            error={serverError}
          />
          <Field
            name="token"
            label="Токен (если есть)"
            placeholder="опционально"
            autocomplete="off"
            bind:value={tokenInput}
          />

          <Button type="submit" loading={connecting}>Войти</Button>
        </form>

        <p class="mt-6 text-center text-[13px] text-fg-muted">
          Нет аккаунта?
          <button
            type="button"
            onclick={() => {
              if (!pendingServer) pendingServer = normalizeServer(serverInput);
              waicordStep = "account";
              accountView = "register";
            }}
            class="ml-1 font-medium text-accent transition hover:text-accent-strong"
          >
            Создать аккаунт
          </button>
        </p>
      {:else if accountView === "register"}
        <img src="/waicord.svg" alt="" class="mx-auto size-14" aria-hidden="true" />
        <h2 class="mt-5 font-display text-[26px] font-semibold tracking-tight">Create your account</h2>
        <p class="mt-1.5 text-sm text-fg-muted">{pendingServer}</p>

        <form class="mt-7 space-y-4 text-left" onsubmit={submitRegister}>
          <Field name="username" label="Логин" placeholder="cool_user" autocomplete="username" bind:value={regUsername} />
          <Field name="email" label="Email" type="email" placeholder="you@example.com" autocomplete="email" bind:value={regEmail} />
          <Field name="reg-password" label="Пароль" type="password" autocomplete="new-password" bind:value={regPassword} />

          {#if regError}
            <p class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-center text-[13px] leading-snug text-danger">
              {regError}
            </p>
          {/if}

          <Button type="submit" loading={loading}>Создать аккаунт</Button>
        </form>

        <p class="mt-6 text-center text-[13px] text-fg-muted">
          Уже есть аккаунт?
          <button
            type="button"
            onclick={() => {
              accountView = "login";
              regError = "";
            }}
            class="ml-1 font-medium text-accent transition hover:text-accent-strong"
          >
            Войти
          </button>
        </p>
      {:else}
        <img src="/waicord.svg" alt="" class="mx-auto size-14" aria-hidden="true" />
        <h2 class="mt-5 font-display text-[26px] font-semibold tracking-tight">Вход в аккаунт</h2>
        <p class="mt-1.5 text-sm text-fg-muted">{pendingServer}</p>

        <form class="mt-7 space-y-4 text-left" onsubmit={submitAccount}>
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

          {#if formError}
            <p class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-center text-[13px] leading-snug text-danger">
              {formError}
            </p>
          {/if}

          <Button type="submit" loading={loading}>Войти</Button>
        </form>

        <div class="my-4 flex items-center gap-3 text-xs text-fg-muted">
          <span class="h-px flex-1 bg-line"></span>
          <span>или</span>
          <span class="h-px flex-1 bg-line"></span>
        </div>

        <button
          type="button"
          disabled
          class="flex h-9 w-full items-center justify-center gap-2.5 rounded-xl bg-white text-[13px] font-medium text-[#1f1f1f] transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          title="Появится после подключения API"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Войти через Google
        </button>

        <p class="mt-6 text-center text-[13px] text-fg-muted">
          <button
            type="button"
            onclick={() => {
              waicordStep = "connect";
              formError = "";
            }}
            class="font-medium text-accent transition hover:text-accent-strong"
          >
            Сменить сервер
          </button>
          <span class="mx-2 text-fg-muted/40">·</span>
          <button
            type="button"
            onclick={() => {
              accountView = "register";
              formError = "";
            }}
            class="font-medium text-accent transition hover:text-accent-strong"
          >
            Создать аккаунт почтой
          </button>
        </p>
      {/if}
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
