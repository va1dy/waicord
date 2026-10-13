<script lang="ts">
  import Button from "../components/ui/Button.svelte";
  import Field from "../components/ui/Field.svelte";
  import { app } from "../lib/app.svelte";
  import type { AuthChallenge } from "../lib/api";

  type Tab = "password" | "qr" | "token";
  type QrStatus = "idle" | "waiting" | "scanned" | "approved" | "cancelled" | "expired" | "error";

  let tab = $state<Tab>("password");
  let email = $state("");
  let password = $state("");
  let loading = $state(false);
  let formError = $state("");

  let challenge = $state<AuthChallenge | null>(null);
  let mfaCode = $state("");
  let mfaMethod = $state<"totp" | "sms">("totp");
  let smsPhone = $state("");

  let tokenInput = $state("");

  let qrImage = $state<string | null>(null);
  let qrUrl = $state<string | null>(null);
  let qrStatus = $state<QrStatus>("idle");
  let qrError = $state("");
  let qrPoll: ReturnType<typeof setInterval> | undefined;

  $effect(() => {
    return () => clearInterval(qrPoll);
  });

  function challengeText(c: AuthChallenge): string {
    if (c.type === "phone") return c.message;
    if (c.type === "email_code") return c.message;
    if (c.type === "captcha") return "Discord запросил капчу — подожди немного и попробуй снова";
    if (c.type === "locked") return c.message;
    return "";
  }

  async function submitPassword(event: Event) {
    event.preventDefault();
    if (loading) return;
    loading = true;
    formError = "";
    try {
      const c = await app.loginPassword(email.trim(), password);
      challenge = c;
      mfaCode = "";
      smsPhone = "";
    } catch (error) {
      formError = error instanceof Error ? error.message : "Не удалось войти";
    } finally {
      loading = false;
    }
  }

  async function submitMfa(event: Event) {
    event.preventDefault();
    if (loading || !challenge || challenge.type !== "mfa") return;
    loading = true;
    formError = "";
    try {
      const c = await app.loginMfa({
        ticket: challenge.ticket,
        loginInstanceId: challenge.loginInstanceId,
        method: mfaMethod,
        code: mfaCode.trim(),
      });
      challenge = c;
      mfaCode = "";
    } catch (error) {
      formError = error instanceof Error ? error.message : "Код не подошёл";
    } finally {
      loading = false;
    }
  }

  async function requestSms() {
    if (!challenge || challenge.type !== "mfa") return;
    formError = "";
    try {
      smsPhone = await app.loginSms(challenge.ticket);
      mfaMethod = "sms";
    } catch (error) {
      formError = error instanceof Error ? error.message : "Не удалось отправить SMS";
    }
  }

  function backToPassword() {
    challenge = null;
    formError = "";
    mfaCode = "";
  }

  async function submitToken(event: Event) {
    event.preventDefault();
    if (loading) return;
    loading = true;
    formError = "";
    try {
      await app.loginToken(tokenInput.trim());
    } catch (error) {
      formError = error instanceof Error ? error.message : "Токен не принят";
    } finally {
      loading = false;
    }
  }

  async function startQr() {
    if (loading) return;
    loading = true;
    formError = "";
    qrError = "";
    clearInterval(qrPoll);
    try {
      const res = await app.startQr();
      qrImage = res.qrImage;
      qrUrl = res.url;
      qrStatus = res.state.status;
      qrPoll = setInterval(async () => {
        try {
          const st = await app.qrState();
          qrStatus = st.status;
          if (st.url) qrUrl = st.url;
          if (st.status === "approved") {
            clearInterval(qrPoll);
            await app.bootAfterQr();
          } else if (st.status === "cancelled" || st.status === "expired" || st.status === "error") {
            clearInterval(qrPoll);
            qrError = st.error ?? (st.status === "expired" ? "Код истёк — запроси новый" : "");
          }
        } catch {
          /* keep polling */
        }
      }, 1500);
    } catch (error) {
      formError = error instanceof Error ? error.message : "Не удалось начать QR-вход";
    } finally {
      loading = false;
    }
  }

  async function cancelQr() {
    clearInterval(qrPoll);
    try {
      await app.cancelQr();
    } catch {
      /* ignore */
    }
    qrStatus = "idle";
    qrImage = null;
  }
</script>

<div class="relative grid h-full place-items-center overflow-hidden">
  <div class="relative z-10 w-full max-w-sm px-4">
    <div class="rounded-2xl border border-line/70 bg-panel/70 p-6 shadow-2xl backdrop-blur-xl">
      <div class="mb-5 flex items-center gap-2.5">
        <img src="/waicord-mark.svg" class="size-7" alt="" aria-hidden="true" />
        <div>
          <h1 class="text-[17px] font-semibold tracking-tight">waicord</h1>
          <p class="text-[12px] text-fg-muted">Discord через локальный мост dsmod</p>
        </div>
      </div>

      {#if app.bootError}
        <p class="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {app.bootError}
        </p>
      {/if}

      <nav class="mb-4 flex gap-1 rounded-xl bg-panel-soft/70 p-1" aria-label="Способ входа">
        {#each [
          { id: "password", label: "Почта" },
          { id: "qr", label: "QR" },
          { id: "token", label: "Токен" },
        ] as t (t.id)}
          <button
            type="button"
            onclick={() => {
              tab = t.id as Tab;
              formError = "";
            }}
            class="h-8 flex-1 rounded-lg text-[13px] font-medium transition {tab === t.id
              ? 'bg-panel text-fg shadow'
              : 'text-fg-muted hover:text-fg'}"
          >
            {t.label}
          </button>
        {/each}
      </nav>

      {#if formError}
        <p class="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {formError}
        </p>
      {/if}

      {#if tab === "password"}
        {#if challenge?.type === "mfa"}
          <form onsubmit={submitMfa} class="flex flex-col gap-3">
            <p class="text-[13px] text-fg-muted">
              Discord запросил подтверждение{challenge.maskedEmail ? ` для ${challenge.maskedEmail}` : ""}
            </p>
            <Field label="Код" name="mfa-code" placeholder="123456" autocomplete="one-time-code" bind:value={mfaCode} />
            {#if mfaMethod === "sms" && smsPhone}
              <p class="text-[12px] text-fg-muted">Код отправлен на {smsPhone}</p>
            {/if}
            <Button type="submit" disabled={loading || !mfaCode.trim()}>
              {loading ? "…" : "Подтвердить"}
            </Button>
            <div class="flex justify-between text-[12px]">
              {#if challenge.methods.includes("sms") && mfaMethod !== "sms"}
                <button type="button" onclick={requestSms} class="text-accent transition hover:underline">
                  Получить по SMS
                </button>
              {:else}
                <span></span>
              {/if}
              <button type="button" onclick={backToPassword} class="text-fg-muted transition hover:text-fg">
                Назад
              </button>
            </div>
          </form>
        {:else if challenge}
          <p class="rounded-lg border border-line bg-panel-soft px-3 py-2 text-[13px] text-fg-muted">
            {challengeText(challenge)}
          </p>
          <button type="button" onclick={backToPassword} class="mt-3 text-[12px] text-accent hover:underline">
            Попробовать снова
          </button>
        {:else}
          <form onsubmit={submitPassword} class="flex flex-col gap-3">
            <Field label="Почта" name="email" type="email" placeholder="you@example.com" autocomplete="email" bind:value={email} />
            <Field label="Пароль" name="password" type="password" autocomplete="current-password" bind:value={password} />
            <Button type="submit" disabled={loading || !email.trim() || !password}>
              {loading ? "…" : "Войти"}
            </Button>
          </form>
        {/if}

      {:else if tab === "qr"}
        {#if qrStatus === "waiting" || qrStatus === "scanned"}
          <div class="flex flex-col items-center gap-3">
            {#if qrImage}
              <img src={qrImage} alt="QR-код входа" class="size-52 rounded-xl bg-white p-2" />
            {/if}
            {#if qrUrl}
              <a href={qrUrl} target="_blank" rel="noreferrer" class="break-all text-[12px] text-accent hover:underline">
                {qrUrl}
              </a>
            {/if}
            <p class="text-[13px] text-fg-muted">
              {qrStatus === "scanned" ? "Отсканировано — подтверди на телефоне" : "Отсканируй код в Discord на телефоне"}
            </p>
            <button type="button" onclick={cancelQr} class="text-[12px] text-fg-muted transition hover:text-fg">
              Отмена
            </button>
          </div>
        {:else if qrStatus === "expired" || qrStatus === "cancelled" || qrStatus === "error"}
          <p class="mb-3 text-[13px] text-danger">{qrError || "QR-вход не удался"}</p>
          <Button type="button" onclick={startQr}>Новый код</Button>
        {:else}
          <div class="flex flex-col gap-3">
            <p class="text-[13px] text-fg-muted">
              Войди с телефона: в Discord наведи камеру на QR-код с экрана.
            </p>
            <Button type="button" onclick={startQr} disabled={loading}>
              {loading ? "…" : "Показать QR-код"}
            </Button>
          </div>
        {/if}

      {:else}
        <form onsubmit={submitToken} class="flex flex-col gap-3">
          <Field label="User-токен" name="token" type="password" placeholder="токен из DevTools" bind:value={tokenInput} />
          <Button type="submit" disabled={loading || !tokenInput.trim()}>
            {loading ? "…" : "Войти по токену"}
          </Button>
        </form>
      {/if}
    </div>
    <p class="mt-3 text-center text-[11px] text-fg-muted/70">
      Токен хранит только мост (~/·dsmod/session.json) · self-bot нарушает ToS Discord
    </p>
  </div>
</div>
