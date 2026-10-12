<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import { call } from "../lib/call.svelte";

  let localVideo = $state<HTMLVideoElement | null>(null);
  let remoteVideo = $state<HTMLVideoElement | null>(null);

  $effect(() => {
    const stream = call.localStream;
    if (localVideo) localVideo.srcObject = stream;
  });

  $effect(() => {
    const stream = call.remoteStream;
    if (remoteVideo) remoteVideo.srcObject = stream;
  });
</script>

{#if call.phase !== "idle"}
  <div class="fixed inset-x-0 bottom-0 z-40 flex justify-center p-4" role="dialog" aria-modal="false" aria-label="Звонок">
    <div class="w-full max-w-lg rounded-2xl border border-line bg-panel/95 p-4 shadow-2xl backdrop-blur">
      {#if call.phase === "incoming"}
        <div class="flex items-center gap-3">
          <Avatar username={call.displayName()} url={call.peerAvatar} size={44} />
          <div class="min-w-0 flex-1">
            <p class="truncate text-[14px] font-semibold">{call.displayName()}</p>
            <p class="text-[12px] text-fg-muted">Входящий звонок…</p>
          </div>
          <button type="button" onclick={() => void call.accept()} class="flex h-10 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-[13px] font-semibold text-white transition hover:bg-emerald-500">
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
            Принять
          </button>
          <button type="button" onclick={() => call.reject()} class="flex h-10 items-center rounded-xl bg-danger px-4 text-[13px] font-semibold text-white transition hover:bg-danger/90">
            Отклонить
          </button>
        </div>
      {:else if call.phase === "outgoing"}
        <div class="flex items-center gap-3">
          <Avatar username={call.displayName()} url={call.peerAvatar} size={44} />
          <div class="min-w-0 flex-1">
            <p class="truncate text-[14px] font-semibold">{call.displayName()}</p>
            <p class="text-[12px] text-fg-muted">Вызов…</p>
          </div>
          <button type="button" onclick={() => call.hangup()} class="flex h-10 items-center rounded-xl bg-danger px-4 text-[13px] font-semibold text-white transition hover:bg-danger/90">
            Отменить
          </button>
        </div>
      {:else}
        {#if call.error}
          <p class="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">{call.error}</p>
        {/if}
        <div class="relative mb-3 overflow-hidden rounded-xl bg-black/70" style="aspect-ratio:16/9">
          <video bind:this={remoteVideo} autoplay playsinline class="h-full w-full object-contain"></video>
          <video bind:this={localVideo} autoplay playsinline muted class="absolute right-2 bottom-2 w-32 rounded-lg border border-line object-cover"></video>
          <p class="absolute top-2 left-2 rounded-lg bg-black/50 px-2 py-1 text-[12px] font-medium text-white">{call.displayName()}</p>
        </div>
        <div class="flex items-center justify-center gap-2">
          <button
            type="button"
            onclick={() => call.toggleMic()}
            title={call.micOn ? "Выключить микрофон" : "Включить микрофон"}
            class="grid size-11 place-items-center rounded-xl border border-line bg-panel-soft transition {call.micOn ? 'text-fg' : 'bg-danger/15 text-danger'}"
          >
            {#if call.micOn}
              <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /></svg>
            {:else}
              <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22" /><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" /><path d="M5 10v2a7 7 0 0 0 12 5" /><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12" /><line x1="12" y1="19" x2="12" y2="22" /></svg>
            {/if}
          </button>
          <button
            type="button"
            onclick={() => call.toggleCam()}
            title={call.camOn ? "Выключить камеру" : "Включить камеру"}
            class="grid size-11 place-items-center rounded-xl border border-line bg-panel-soft transition {call.camOn ? 'text-fg' : 'bg-danger/15 text-danger'}"
          >
            {#if call.camOn}
              <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8z" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>
            {:else}
              <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.66 6H14a2 2 0 0 1 2 2v3.34l1 1L22 8v8" /><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10z" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
            {/if}
          </button>
          <button
            type="button"
            onclick={() => void call.toggleScreen()}
            title={call.screenOn ? "Остановить показ" : "Показать экран"}
            class="grid size-11 place-items-center rounded-xl border border-line bg-panel-soft transition {call.screenOn ? 'text-accent' : 'text-fg'}"
          >
            <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
          </button>
          <button type="button" onclick={() => call.hangup()} title="Завершить" class="ml-2 flex h-11 items-center gap-1.5 rounded-xl bg-danger px-4 text-[13px] font-semibold text-white transition hover:bg-danger/90">
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" /><line x1="23" y1="1" x2="1" y2="23" /></svg>
            Завершить
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
