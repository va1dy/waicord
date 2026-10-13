/**
 * Голос: соединение, DAVE (E2EE), кодек, менеджер.
 * Публичные точки входа — VoiceManager у DscClient (client.voice).
 */
export { VoiceConnection, type VoiceConnectionOptions, type VoiceLinkPhase, type VoiceLinkStatus } from "./connection";
export { VoiceManager, type JoinVoicePayload } from "./manager";
export { DaveHandler, DaveOpcode, DAVE_PROTOCOL_VERSION, type DaveIO } from "./dave";
export { OpusCodec, CHANNELS, FRAME_BYTES, FRAME_SAMPLES, SAMPLE_RATE, SILENCE_FRAME } from "./opus";
export {
  buildRtpHeader,
  chooseMode,
  decryptRtpPayload,
  encryptRtpPacket,
  readSsrc,
  RTP_PAYLOAD_TYPE,
  SUPPORTED_MODES,
  type EncryptionMode,
} from "./rtp";
