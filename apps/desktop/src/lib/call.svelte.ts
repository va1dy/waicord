import { app } from "./app.svelte";

export type CallPhase = "idle" | "outgoing" | "incoming" | "active";

type SignalEvent = {
  from: string;
  from_username: string;
  from_display_name: string | null;
  from_avatar_url: string | null;
  payload: Record<string, unknown>;
};

class CallManager {
  phase = $state<CallPhase>("idle");
  callId = $state("");
  peerId = $state("");
  peerName = $state("");
  peerAvatar = $state<string | null>(null);
  conversationId = $state("");
  localStream = $state<MediaStream | null>(null);
  remoteStream = $state<MediaStream | null>(null);
  micOn = $state(true);
  camOn = $state(false);
  screenOn = $state(false);
  error = $state("");

  private pc: RTCPeerConnection | null = null;
  private pendingOffer: RTCSessionDescriptionInit | null = null;
  private isOfferer = false;
  private videoTrack: MediaStreamTrack | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;

  displayName(): string {
    return this.peerName || this.peerId;
  }

  async start(conversationId: string, peerId: string, peerName: string, peerAvatar: string | null = null) {
    if (this.phase !== "idle" || !peerId) return;
    this.error = "";
    this.callId = crypto.randomUUID();
    this.conversationId = conversationId;
    this.peerId = peerId;
    this.peerName = peerName;
    this.peerAvatar = peerAvatar;
    this.phase = "outgoing";
    app.sendSignal(peerId, { kind: "call-invite", callId: this.callId, conversationId });
  }

  async accept() {
    if (this.phase !== "incoming") return;
    this.error = "";
    try {
      await this.setupAudio();
      this.phase = "active";
      app.sendSignal(this.peerId, { kind: "call-accept", callId: this.callId });
      await this.flushPendingOffer();
    } catch {
      this.error = "Нет доступа к микрофону";
      this.reject();
    }
  }

  reject() {
    if (this.peerId) app.sendSignal(this.peerId, { kind: "call-reject", callId: this.callId });
    this.reset();
  }

  hangup() {
    if (this.phase !== "idle" && this.peerId) {
      app.sendSignal(this.peerId, { kind: "call-hangup", callId: this.callId });
    }
    this.reset();
  }

  toggleMic() {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.micOn = track.enabled;
  }

  async toggleCam() {
    if (this.phase !== "active") return;
    try {
      if (this.camOn) {
        await this.setVideoTrack(null);
        this.camTrack?.stop();
        this.camTrack = null;
        this.camOn = false;
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 360 } },
        });
        const track = stream.getVideoTracks()[0]!;
        this.camTrack = track;
        await this.setVideoTrack(track);
        this.camOn = true;
      }
    } catch {
      this.error = "Нет доступа к камере";
    }
  }

  async toggleScreen() {
    if (this.phase !== "active") return;
    try {
      if (this.screenOn) {
        await this.setVideoTrack(this.camOn ? this.camTrack : null);
        this.screenTrack?.stop();
        this.screenTrack = null;
        this.screenOn = false;
      } else {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0]!;
        this.screenTrack = track;
        track.onended = () => {
          void this.toggleScreen();
        };
        await this.setVideoTrack(track);
        this.screenOn = true;
      }
    } catch {
      this.error = "Не удалось показать экран";
    }
  }

  async onSignal(event: SignalEvent) {
    const payload = event.payload as {
      kind?: string;
      callId?: string;
      conversationId?: string;
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    const kind = payload.kind;

    if (kind === "call-invite") {
      if (this.phase !== "idle") {
        app.sendSignal(event.from, { kind: "call-busy", callId: payload.callId });
        return;
      }
      this.callId = payload.callId ?? "";
      this.peerId = event.from;
      this.peerName = event.from_display_name || event.from_username;
      this.peerAvatar = event.from_avatar_url;
      this.conversationId = payload.conversationId ?? "";
      this.error = "";
      this.isOfferer = false;
      this.phase = "incoming";
      return;
    }

    if (payload.callId && payload.callId !== this.callId) return;

    if (kind === "call-accept") {
      if (this.phase !== "outgoing") return;
      try {
        await this.setupAudio();
        this.phase = "active";
        await this.negotiate();
      } catch {
        this.error = "Нет доступа к микрофону";
        this.hangup();
      }
      return;
    }

    if (kind === "call-reject") {
      if (this.phase === "outgoing") this.error = "Вызов отклонён";
      this.resetKeepError();
      return;
    }

    if (kind === "call-busy") {
      this.error = "Абонент занят";
      this.resetKeepError();
      return;
    }

    if (kind === "call-hangup") {
      this.reset();
      return;
    }

    if (kind === "renegotiate") {
      if (this.isOfferer && this.phase === "active") await this.negotiate();
      return;
    }

    if (kind === "rtc-offer") {
      this.pendingOffer = payload.sdp ?? null;
      await this.flushPendingOffer();
      return;
    }

    if (kind === "rtc-answer") {
      if (payload.sdp && this.pc) await this.pc.setRemoteDescription(payload.sdp);
      return;
    }

    if (kind === "rtc-ice") {
      if (payload.candidate) {
        try {
          await this.pc?.addIceCandidate(payload.candidate);
        } catch {
          /* too late candidates — ignore */
        }
      }
    }
  }

  private async setupAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.localStream = stream;
    this.micOn = true;
    this.camOn = false;
    this.screenOn = false;
    this.ensurePc();
    const audio = stream.getAudioTracks()[0];
    if (audio && !this.pc!.getSenders().some((s) => s.track === audio)) {
      this.pc!.addTrack(audio, stream);
    }
  }

  private async setVideoTrack(track: MediaStreamTrack | null) {
    const pc = this.ensurePc();
    this.videoTrack = track;
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(track);
      return;
    }
    if (track) {
      const stream = this.localStream ?? new MediaStream();
      if (!this.localStream) this.localStream = stream;
      stream.addTrack(track);
      pc.addTrack(track, stream);
    }
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        app.sendSignal(this.peerId, { kind: "rtc-ice", callId: this.callId, candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      this.remoteStream = e.streams[0] ?? new MediaStream([e.track]);
    };
    pc.onnegotiationneeded = () => {
      if (this.phase !== "active") return;
      if (this.isOfferer) void this.negotiate();
      else if (this.peerId) app.sendSignal(this.peerId, { kind: "renegotiate", callId: this.callId });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        if (this.phase === "active") this.reset();
      }
    };
    this.pc = pc;
    return pc;
  }

  private async negotiate() {
    const pc = this.ensurePc();
    this.isOfferer = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    app.sendSignal(this.peerId, { kind: "rtc-offer", callId: this.callId, sdp: pc.localDescription });
  }

  private async flushPendingOffer() {
    if (!this.pendingOffer || this.phase !== "active" || !this.pc) return;
    const offer = this.pendingOffer;
    this.pendingOffer = null;
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    app.sendSignal(this.peerId, { kind: "rtc-answer", callId: this.callId, sdp: this.pc.localDescription });
  }

  private resetKeepError() {
    this.teardown();
  }

  private reset() {
    this.error = "";
    this.teardown();
  }

  private teardown() {
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.camTrack?.stop();
    this.screenTrack?.stop();
    this.camTrack = null;
    this.screenTrack = null;
    this.videoTrack = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingOffer = null;
    this.isOfferer = false;
    this.phase = "idle";
    this.callId = "";
    this.peerId = "";
    this.peerName = "";
    this.peerAvatar = null;
    this.conversationId = "";
    this.micOn = true;
    this.camOn = false;
    this.screenOn = false;
  }
}

export const call = new CallManager();
