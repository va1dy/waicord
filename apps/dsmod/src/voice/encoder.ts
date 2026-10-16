/**
 * Захват экрана и H264-энкодер для Go Live (ffmpeg во внешнем процессе).
 *
 * Захват: gdigrab (Windows: `desktop` — весь экран, либо `title=<окно>`),
 * кодирование: libx264 с tune=zerolatency. stdout — Annex-B H264,
 * границы кадров помечает AUD-NAL (`00 00 01 09`, включается
 * параметром x264 `aud=1`); отсюда читаем кадры и шлём в
 * StreamConnection.sendVideoFrame.
 *
 * ffmpeg ищется в DSMOD_FFMPEG_PATH / FFMPEG_PATH, затем в
 * `~/.dsmod/bin/ffmpeg.exe`, затем в PATH; если не нашёлся —
 * скачивается (сборка BtbN, GPL) в `~/.dsmod/bin`. Проверки и загрузка
 * описаны в docs/voice.md.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Старт-код + AUD NAL — признак начала нового кадра (x264 aud=1). */
const AUD_START = Buffer.from([0x00, 0x00, 0x01, 0x09]);
/** Предохранитель: столько байт без AUD считаем мусором и сбрасываем. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

const DOWNLOAD_URL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

export interface ScreenEncoderOptions {
  /** Итоговое разрешение (w:h, чётные); кадр вписывается с чёрными полями. */
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  /** "desktop" (весь экран) или название окна для захвата. */
  source?: string;
}

/** Куда положить скачанный ffmpeg. */
export function ffmpegLocalPath(): string {
  return join(homedir(), ".dsmod", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

/** Найти ffmpeg: env → ~/.dsmod/bin → PATH. null — не нашли. */
export function ffmpegPath(): string | null {
  for (const candidate of [process.env.DSMOD_FFMPEG_PATH, process.env.FFMPEG_PATH]) {
    const value = candidate?.trim();
    if (value && existsSync(value)) return value;
  }
  const local = ffmpegLocalPath();
  if (existsSync(local)) return local;
  try {
    const probe = spawnSync("ffmpeg", ["-version"], { windowsHide: true, timeout: 5000 });
    if (probe.status === 0) return "ffmpeg";
  } catch {
    // ffmpeg в PATH нет — это не ошибка
  }
  return null;
}

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `powershell завершился с кодом ${code}`));
    });
  });
}

/** Скачать ffmpeg в ~/.dsmod/bin (только Windows; curl идёт без revocation-проверки). */
export async function downloadFfmpeg(onDebug?: (line: string) => void): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("автоустановка ffmpeg поддержана только на Windows — укажите FFMPEG_PATH");
  }
  const target = ffmpegLocalPath();
  onDebug?.("ffmpeg не найден — скачиваю сборку BtbN (~200 МБ, только один раз)…");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$dir = Split-Path -Parent '${target}'`,
    "New-Item -ItemType Directory -Force $dir | Out-Null",
    "$zip = Join-Path $env:TEMP 'dsmod-ffmpeg.zip'",
    "$tmp = Join-Path $env:TEMP 'dsmod-ffmpeg'",
    "if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }",
    `curl.exe --ssl-no-revoke -L --fail --silent --show-error -o $zip '${DOWNLOAD_URL}'`,
    "Expand-Archive -Path $zip -DestinationPath $tmp -Force",
    "$ff = Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1",
    `Copy-Item $ff.FullName '${target}' -Force`,
    "Remove-Item -Force $zip",
    "Remove-Item -Recurse -Force $tmp",
  ].join("; ");
  await runPowerShell(script);
  if (!existsSync(target)) throw new Error("ffmpeg не появился после установки");
  onDebug?.(`ffmpeg установлен: ${target}`);
  return target;
}

/** Найти ffmpeg или установить его (используется при старте трансляции). */
export async function ensureFfmpeg(onDebug?: (line: string) => void): Promise<string> {
  const found = ffmpegPath();
  if (found) return found;
  return downloadFfmpeg(onDebug);
}

/** Аргументы входа видео: платформа → флаги ffmpeg. */
function captureInputArgs(opts: ScreenEncoderOptions): string[] {
  const source = opts.source?.trim() || "desktop";
  if (process.platform === "win32") {
    return ["-f", "gdigrab", "-framerate", String(opts.fps), "-i", source];
  }
  if (process.platform === "darwin") {
    const input = source === "desktop" ? "1:none" : source;
    return ["-f", "avfoundation", "-framerate", String(opts.fps), "-i", input];
  }
  const display = source === "desktop" ? process.env.DISPLAY || ":0.0" : source;
  return ["-f", "x11grab", "-framerate", String(opts.fps), "-i", display];
}

/**
 * Один процесс ffmpeg: захват → H264 (Annex-B) → stdout.
 *
 * События:
 *   frame (Buffer, frametimeMs) — готовый кадр (аксесс-юнит) без AUD-хвоста;
 *   exit  ({ code })            — процесс завершился сам (не через stop());
 *   error (Error)               — не удалось запустить процесс.
 */
export class ScreenEncoder extends EventEmitter {
  /** Сколько кадров уже отдано наружу. */
  frames = 0;
  /** Сколько байт (суммарно по кадрам). */
  bytes = 0;

  private proc: ChildProcess | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private seenFirstAud = false;
  private stopping = false;
  private stderrTail: string[] = [];

  constructor(private readonly opts: ScreenEncoderOptions) {
    super();
  }

  /** Шаг метки времени для RTP (1000/fps мс). */
  get frametimeMs(): number {
    return 1000 / this.opts.fps;
  }

  /** Последние строки stderr ffmpeg — для сообщения об ошибке. */
  lastError(): string {
    return this.stderrTail.join("\n").trim();
  }

  start(exe: string): void {
    const { width, height, fps, bitrateKbps } = this.opts;
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      ...captureInputArgs(this.opts),
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-pix_fmt", "yuv420p",
      "-b:v", `${bitrateKbps}k`,
      "-maxrate", `${bitrateKbps}k`,
      "-bufsize", `${bitrateKbps * 2}k`,
      "-g", String(fps * 2),
      "-x264-params", "aud=1:scenecut=0",
      "-flush_packets", "1",
      "-f", "h264",
      "pipe:1",
    ];
    const proc = spawn(exe, args, { windowsHide: true });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => this.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
      }
      if (this.stderrTail.length > 20) this.stderrTail.splice(0, this.stderrTail.length - 20);
    });
    proc.on("error", (err) => this.emit("error", err));
    proc.on("close", (code) => {
      this.proc = null;
      if (!this.stopping) this.emit("exit", { code });
    });
  }

  /** Остановить ffmpeg (кадры больше не приходят). */
  stop(): void {
    this.stopping = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // процесс уже мог завершиться
    }
  }

  /** stdout: режем поток на кадры по AUD (00 00 01 09). */
  private push(chunk: Buffer): void {
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      const index = this.pending.indexOf(AUD_START, this.seenFirstAud ? 4 : 0);
      if (index === -1) break;
      if (this.seenFirstAud && index > 0) {
        const frame = this.pending.subarray(0, index);
        if (frame.length > 0) {
          this.frames += 1;
          this.bytes += frame.length;
          this.emit("frame", frame, this.frametimeMs);
        }
      }
      // Текущий кадр начинается с найденного AUD — ждём начала следующего.
      this.pending = this.pending.subarray(index);
      this.seenFirstAud = true;
    }
    if (this.pending.length > MAX_PENDING_BYTES) this.pending = Buffer.alloc(0);
  }
}
