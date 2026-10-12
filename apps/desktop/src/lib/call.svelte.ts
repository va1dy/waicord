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
  camOn = $state(true);
  screenOn = $state(false);
  error = $state("");

  private pc: RTCPeerConnection | null = null;
  private pendingOffer: RTCSessionDescriptionInit | null = null;
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
      await this.setupMedia();
      this.phase = "active";
      await this.flushPendingOffer();
    } catch {
      this.error = "Нет доступа к камере/микрофону";
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

  toggleCam() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.camOn = track.enabled;
  }

  async toggleScreen() {
    if (this.phase !== "active") return;
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "video");
    try {
      if (this.screenOn) {
        const cam = this.localStream?.getVideoTracks()[0] ?? null;
        if (sender) await sender.replaceTrack(cam);
        this.screenTrack?.stop();
        this.screenTrack = null;
        this.screenOn = false;
      } else {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        if (sender) await sender.replaceTrack(track);
        else this.localStream?.addTrack(track);
        track.onended = () => {
          void this.toggleScreen();
        };
        this.screenTrack = track;
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
      this.phase = "incoming";
      return;
    }

    if (payload.callId && payload.callId !== this.callId) return;

    if (kind === "call-accept") {
      if (this.phase !== "outgoing") return;
      try {
        await this.setupMedia();
        this.phase = "active";
        await this.negotiate();
      } catch {
        this.error = "Нет доступа к камере/микрофону";
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

    if (kind === "rtc-offer") {
      this.pendingOffer = payload.sdp ?? null;
      await this.flushPendingOffer();
      return;
    }

    if (kind === "rtc-answer") {
      if (payload.sdp) await this.pc?.setRemoteDescription(payload.sdp);
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

  private async setupMedia() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
    });
    this.localStream = stream;
    this.micOn = true;
    this.camOn = true;
    this.screenOn = false;
    this.ensurePc();
    for (const track of stream.getTracks()) {
      if (!this.pc!.getSenders().some((s) => s.track === track)) {
        this.pc!.addTrack(track, stream);
      }
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
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        if (this.phase === "active") this.reset();
      }
    };
    this.pc = pc;
    return pc;
  }

  private async negotiate() {
    const pc = this.ensurePc();
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
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingOffer = null;
    this.phase = "idle";
    this.callId = "";
    this.peerId = "";
    this.peerName = "";
    this.peerAvatar = null;
    this.conversationId = "";
    this.micOn = true;
    this.camOn = true;
    this.screenOn = false;
  }
}

export const call = new CallManager();
