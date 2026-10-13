/**
 * DAVE — сквозное шифрование звонков (обязательно у Discord с 03.2026).
 *
 * Тяжёлую криптографию (MLS/OpenMLS) делает @snazzah/davey (та же
 * библиотека, что в @discordjs/voice); здесь — диспетчеризация
 * голосовых опкодов 21–31 по схеме из официального примера
 * discord/libdave/samples/typescript.
 *
 * Опкоды бинарные: [seq u16 BE ← только сервер→клиент][opcode u8][payload].
 * Клиент→сервер — просто [opcode u8][payload].
 */
import { DAVE_PROTOCOL_VERSION, DAVESession, type ProposalsResult } from "@snazzah/davey";
import type { VoiceDaveDTO } from "../types";
import { SILENCE_FRAME } from "./opus";

export { DAVE_PROTOCOL_VERSION };

/** Голосовые опкоды DAVE. */
export const DaveOpcode = {
  PrepareTransition: 21,
  ExecuteTransition: 22,
  TransitionReady: 23,
  PrepareEpoch: 24,
  ExternalSender: 25,
  KeyPackage: 26,
  Proposals: 27,
  CommitWelcome: 28,
  AnnounceCommitTransition: 29,
  Welcome: 30,
  InvalidCommitWelcome: 31,
} as const;

/** После стольких подряд неудачных расшифровок переинициализируем сессию. */
const DECRYPTION_FAILURE_TOLERANCE = 36;

/** Типы операций в опкоде 27 (ProposalsOperationType). */
const PROPOSALS_APPEND = 0;
const PROPOSALS_REVOKE = 1;

export interface DaveIO {
  sendJson(op: number, d: Record<string, unknown>): void;
  sendBinary(op: number, payload: Buffer): void;
  /** Состояние сессии изменилось (версия/готовность/код приватности). */
  onState(state: VoiceDaveDTO): void;
  onDebug?(message: string): void;
}

/**
 * Состояние одной DAVE-сессии голосового подключения.
 * Создаётся заново при каждом подключении (сессия не переживает реконнект).
 */
export class DaveHandler {
  private session: DAVESession | null = null;
  private protocolVersion = 0;
  private readonly pending = new Map<number, number>();
  private recognized = new Set<string>();
  private downgraded = false;
  private failures = 0;
  private lastTransitionId = 0;
  private recovering = false;

  constructor(
    private readonly userId: string,
    private readonly channelId: string,
    private readonly io: DaveIO,
  ) {}

  /** E2EE вообще включено для этого подключения. */
  get enabled(): boolean {
    return this.session !== null;
  }

  state(): VoiceDaveDTO {
    return {
      version: this.protocolVersion,
      ready: this.session?.ready ?? false,
      privacyCode: this.session?.voicePrivacyCode ?? "",
    };
  }

  /** Opcode 4 Session Description → выбрать версию протокола и поднять сессию. */
  init(protocolVersion: number): void {
    this.protocolVersion = protocolVersion;
    if (protocolVersion > 0) {
      if (!this.session) {
        this.session = new DAVESession(protocolVersion, this.userId, this.channelId);
      } else {
        this.session.reinit(protocolVersion, this.userId, this.channelId);
      }
      this.sendKeyPackage();
    } else if (this.session) {
      this.session.reset();
    }
    this.io.onState(this.state());
  }

  /** Opcode 21: готовим переход. true → нужно ответить опкодом 23. */
  prepareTransition(d: { transition_id?: unknown; protocol_version?: unknown }): boolean {
    const id = Number(d.transition_id ?? 0);
    const version = Number(d.protocol_version ?? 0);
    this.pending.set(id, version);
    // переход 0 применяется сразу и подтверждения не требует
    if (id === 0) {
      this.executeTransition(id);
      return false;
    }
    // при даунгрейде часть пакетов ещё может приходить в старом формате
    if (version === 0) this.session?.setPassthroughMode(true, 24);
    return true;
  }

  /** Opcode 22: применяем подготовленный переход. */
  executeTransition(id: number): boolean {
    const version = this.pending.get(id);
    if (version === undefined) return false;
    this.pending.delete(id);
    this.protocolVersion = version;
    if (version === 0) {
      this.downgraded = true;
      this.session?.reset();
    } else if (this.downgraded) {
      // после возврата на E2EE короткое окно passthrough, чтобы не рвать звук
      this.session?.setPassthroughMode(true, 10);
      this.downgraded = false;
    }
    this.io.onState(this.state());
    return true;
  }

  /** Opcode 24: новая MLS-эпоха (epoch 1 = первая ключевая группа). */
  prepareEpoch(d: { epoch?: unknown; protocol_version?: unknown }): void {
    if (String(d.epoch) !== "1") return;
    const version = Number(d.protocol_version ?? 0);
    if (version === 0 || !this.session) return;
    this.protocolVersion = version;
    this.session.reinit(version, this.userId, this.channelId);
    this.sendKeyPackage();
    this.io.onState(this.state());
  }

  /** Opcode 25: внешний отправитель (сервер подписывает commit'ы). */
  setExternalSender(payload: Buffer): void {
    if (!this.session || payload.length === 0) return;
    try {
      this.session.setExternalSender(payload);
    } catch (err) {
      this.io.onDebug?.(`dave setExternalSender: ${String(err)}`);
    }
  }

  /** Opcode 27: proposal'ы от сервера → при необходимости отправляем commit/welcome (28). */
  processProposals(payload: Buffer): void {
    if (!this.session || payload.length < 1) return;
    const operation = payload[0] === PROPOSALS_REVOKE ? PROPOSALS_REVOKE : PROPOSALS_APPEND;
    try {
      const result: ProposalsResult = this.session.processProposals(
        operation,
        payload.subarray(1),
        [...this.recognized],
      );
      if (result.commit) {
        const body = result.welcome
          ? Buffer.concat([result.commit, result.welcome])
          : result.commit;
        this.io.sendBinary(DaveOpcode.CommitWelcome, body);
      }
    } catch (err) {
      this.io.onDebug?.(`dave processProposals: ${String(err)}`);
    }
  }

  /** Opcode 29: сервер объявил commit → применяем и подтверждаем (23). */
  processCommit(payload: Buffer): void {
    if (!this.session || payload.length < 2) return;
    const transitionId = payload.readUInt16BE(0);
    this.lastTransitionId = transitionId;
    try {
      this.session.processCommit(payload.subarray(2));
      this.onAccepted(transitionId);
    } catch (err) {
      this.io.onDebug?.(`dave processCommit: ${String(err)}`);
      this.recover(transitionId);
    }
  }

  /** Opcode 30: welcome в новую группу (мы добавлены участниками). */
  processWelcome(payload: Buffer): void {
    if (!this.session || payload.length < 2) return;
    const transitionId = payload.readUInt16BE(0);
    this.lastTransitionId = transitionId;
    try {
      this.session.processWelcome(payload.subarray(2));
      this.onAccepted(transitionId);
    } catch (err) {
      this.io.onDebug?.(`dave processWelcome: ${String(err)}`);
      this.recover(transitionId);
    }
  }

  /** Пользователь подключился/отключился — обновляем список «распознаваемых». */
  setRecognized(userIds: Iterable<string>): void {
    this.recognized = new Set(userIds);
  }

  addRecognized(userId: string): void {
    this.recognized.add(userId);
  }

  removeRecognized(userId: string): void {
    this.recognized.delete(userId);
  }

  /** E2EE-шифрование исходящего opus-пакета (иначе — как есть). */
  encrypt(payload: Buffer): Buffer {
    if (this.protocolVersion === 0 || !this.session?.ready) return payload;
    if (payload.equals(SILENCE_FRAME)) return payload;
    try {
      return this.session.encryptOpus(payload);
    } catch (err) {
      this.io.onDebug?.(`dave encrypt: ${String(err)}`);
      return payload;
    }
  }

  /** Расшифровка входящего пакета; null — отбрасываем (не расшифровался). */
  decrypt(userId: string, payload: Buffer): Buffer | null {
    if (this.protocolVersion === 0 || !this.session) return payload;
    if (payload.equals(SILENCE_FRAME)) return payload;
    if (!(this.session.ready || this.session.canPassthrough(userId))) return null;
    try {
      const out = this.session.decrypt(userId, 0 /* MediaType.AUDIO */, payload);
      this.failures = 0;
      return out;
    } catch {
      this.failures += 1;
      if (this.failures > DECRYPTION_FAILURE_TOLERANCE && this.pending.size === 0 && !this.recovering) {
        this.recover(this.lastTransitionId);
      }
      return null;
    }
  }

  private onAccepted(transitionId: number): void {
    this.failures = 0;
    if (transitionId === 0) {
      this.io.onState(this.state());
      return;
    }
    this.io.sendJson(DaveOpcode.TransitionReady, { transition_id: transitionId });
  }

  /** Невалидный commit/welcome → опкод 31 и свежая группа с новым key package. */
  private recover(transitionId: number): void {
    if (this.recovering) return;
    this.recovering = true;
    this.io.sendJson(DaveOpcode.InvalidCommitWelcome, { transition_id: transitionId });
    const version = this.protocolVersion || DAVE_PROTOCOL_VERSION;
    if (this.session) {
      this.session.reinit(version, this.userId, this.channelId);
    } else {
      this.session = new DAVESession(version, this.userId, this.channelId);
      this.protocolVersion = version;
    }
    this.failures = 0;
    this.recovering = false;
    this.sendKeyPackage();
    this.io.onState(this.state());
  }

  private sendKeyPackage(): void {
    if (!this.session) return;
    try {
      this.io.sendBinary(DaveOpcode.KeyPackage, this.session.getSerializedKeyPackage());
    } catch (err) {
      this.io.onDebug?.(`dave key package: ${String(err)}`);
    }
  }
}
