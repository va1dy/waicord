<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import { app } from "../lib/app.svelte";
  import { avatarOf, type VoiceStateDTO } from "../lib/api";

  const voice = $derived(app.voice);
  const participants = $derived(voice?.participants ?? []);
  const isActive = $derived(app.isInVoice());
  const isScreenSharing = $derived(app.isScreenSharing());
  const pushToTalk = $derived(app.pushToTalk);

  let micStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let pttHandler: ((e: KeyboardEvent) => void) | null = null;

  $effect(() => {
    if (!isActive) {
      stopMic();
      return;
    }
    if (!pushToTalk) {
      startMic();
    } else {
      stopMic();
    }
    return () => stopMic();
  });

  $effect(() => {
    if (!pushToTalk || !isActive) return;
    pttHandler = (e: KeyboardEvent) => {
      if (e.code === "KeyV" && !e.repeat && !(e.target as HTMLElement)?.matches("input, textarea")) {
        void app.setSpeaking(true);
        startMic();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "KeyV") {
        void app.setSpeaking(false);
        stopMic();
      }
    };
    window.addEventListener("keydown", pttHandler);
    window.addEventListener("keyup", up);
    return () => {
      if (pttHandler) window.removeEventListener("keydown", pttHandler);
      window.removeEventListener("keyup", up);
    };
  });

  async function startMic() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: app.noiseSuppression,
          autoGainControl: true,
        },
      });
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(micStream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioCtx.destination);
      void app.setMicActive(true);
    } catch {
    }
  }

  function stopMic() {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      void audioCtx.close();
      audioCtx = null;
    }
    void app.setMicActive(false);
  }

  async function toggleScreenShare() {
    if (isScreenSharing) {
      await app.stopScreenShare();
    } else {
      await app.startScreenShare(30, 1280);
    }
  }

  function participantName(p: VoiceStateDTO): string {
    return app.users[p.userId]?.displayName || app.users[p.userId]?.username || "Участник";
  }

  function participantAvatar(p: VoiceStateDTO): string | null {
    return avatarOf(app.users[p.userId] ?? null);
  }

  function participantAvatarIndex(p: VoiceStateDTO): number {
    return app.users[p.userId]?.defaultAvatarIndex ?? 0;
  }
</script>

{#if isActive && voice}
  <div class="border-b border-line/60 bg-panel-soft/30 px-4 py-3">
    <div class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <span class="size-2 shrink-0 rounded-full {voice.phase === 'ready' ? 'bg-emerald-400' : 'bg-amber-400'}"></span>
        <span class="truncate text-[13px] font-medium">
          {voice.phase === "ready" ? "Голосовой канал" : voice.phase === "connecting" ? "Подключение…" : voice.phase === "reconnecting" ? "Переподключение…" : "Голос"}
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onclick={toggleScreenShare}
          class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition {isScreenSharing ? 'bg-danger/20 text-danger' : 'bg-panel-soft text-fg-muted hover:text-fg'}"
          title={isScreenSharing ? "Остановить трансляцию" : "Поделиться экраном"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          {isScreenSharing ? "Стоп" : "Экран"}
        </button>
        <button
          type="button"
          onclick={() => void app.toggleMute()}
          class="flex h-8 w-8 items-center justify-center rounded-lg transition {voice.participants.find((p) => p.userId === app.me?.id)?.selfMute ? 'bg-danger/20 text-danger' : 'bg-panel-soft text-fg-muted hover:text-fg'}"
          title="Микрофон"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
          </svg>
        </button>
        <button
          type="button"
          onclick={() => void app.leaveVoice()}
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-danger/20 text-danger transition hover:bg-danger/30"
          title="Отключиться"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67M6.21 3.07A19.79 19.79 0 0 1 2.18 2 2 2 0 0 1 .18-2v3a2 2 0 0 1 .54 1.45 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L3.41 10.68" />
          </svg>
        </button>
      </div>
    </div>
    {#if participants.length > 0}
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        {#each participants as p (p.userId)}
          <span class="flex items-center gap-1 rounded-full bg-panel-soft/60 py-0.5 pr-2 pl-0.5 text-[11px] text-fg-muted">
            <Avatar username={participantName(p)} url={participantAvatar(p)} defaultIndex={participantAvatarIndex(p)} size={16} />
            <span class="max-w-20 truncate">{participantName(p)}</span>
          </span>
        {/each}
      </div>
    {/if}
    {#if pushToTalk}
      <p class="mt-1.5 text-[11px] text-fg-muted/60">PTT: зажми <kbd class="rounded bg-panel-soft px-1 font-mono">V</kbd></p>
    {/if}
  </div>
{/if}
