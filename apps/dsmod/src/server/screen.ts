
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface ScreenOptions {
  /** Кадров в секунду, 1..10 (по умолчанию 2) */
  fps?: number;
  /** Ширина кадра в пикселях, 320..1920 (по умолчанию 1280) */
  width?: number;
}

export interface ScreenStatus {
  active: boolean;
  fps: number;
  width: number;
  /** Сколько кадров отправлено с момента старта */
  frames: number;
  lastFrameAt: string | null;
  error: string | null;
}

export interface ScreenFrame {
  seq: number;
  ts: string;
  /** JPEG в base64 — рисовать как <img src="data:image/jpeg;base64,…"> */
  jpeg: string;
}

const DEFAULT_FPS = 2;
const DEFAULT_WIDTH = 1280;
const BASE64_LINE = /^[A-Za-z0-9+/]{100,}={0,2}$/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Скрипт PS: пишет в stdout по одному base64-JPEG кадру за итерацию. */
function psScript(fps: number, width: number): string {
  const interval = Math.max(100, Math.floor(1000 / fps));
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$targetW = ${width}`,
    `$interval = ${interval}`,
    "while ($true) {",
    "  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "  $src = New-Object System.Drawing.Bitmap($b.Width, $b.Height)",
    "  $g1 = [System.Drawing.Graphics]::FromImage($src)",
    "  $g1.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $src.Size)",
    "  $targetH = [Math]::Max(1, [int]($b.Height * $targetW / $b.Width))",
    "  $dst = New-Object System.Drawing.Bitmap($targetW, $targetH)",
    "  $g2 = [System.Drawing.Graphics]::FromImage($dst)",
    "  $g2.DrawImage($src, 0, 0, $targetW, $targetH)",
    "  $ms = New-Object System.IO.MemoryStream",
    "  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
    "  $p = New-Object System.Drawing.Imaging.EncoderParameters(1)",
    "  $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]60)",
    "  $dst.Save($ms, $enc, $p)",
    "  [Console]::Out.WriteLine([Convert]::ToBase64String($ms.ToArray()))",
    "  [Console]::Out.Flush()",
    "  $g1.Dispose(); $g2.Dispose(); $src.Dispose(); $dst.Dispose(); $ms.Dispose()",
    "  Start-Sleep -Milliseconds $interval",
    "}",
  ].join("\n");
}

/** Одна сессия захвата экрана (на мост — максимум одна). */
export class ScreenCapture extends EventEmitter {
  private child: ChildProcess | null = null;
  private fps = DEFAULT_FPS;
  private width = DEFAULT_WIDTH;
  private frames = 0;
  private seq = 0;
  private lastFrameAt: string | null = null;
  private error: string | null = null;
  private buffer = "";

  status(): ScreenStatus {
    return {
      active: this.child !== null,
      fps: this.fps,
      width: this.width,
      frames: this.frames,
      lastFrameAt: this.lastFrameAt,
      error: this.error,
    };
  }

  /** Запускает захват (повторный вызов — перезапуск с новыми параметрами). */
  start(options: ScreenOptions = {}): ScreenStatus {
    this.stopProcess();
    this.fps = clamp(Math.floor(options.fps ?? DEFAULT_FPS), 1, 10);
    this.width = clamp(Math.floor(options.width ?? DEFAULT_WIDTH), 320, 1920);
    this.frames = 0;
    this.lastFrameAt = null;
    this.error = null;
    this.buffer = "";

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript(this.fps, this.width)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text && !this.error) this.error = text.split("\n")[0] ?? text;
    });
    child.on("error", (err) => {
      this.error = String(err);
      this.child = null;
      this.emit("status", this.status());
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (code !== 0 && code !== null && !this.error) this.error = `powershell exited with ${code}`;
      this.emit("status", this.status());
    });

    this.emit("status", this.status());
    return this.status();
  }

  stop(): ScreenStatus {
    this.stopProcess();
    this.emit("status", this.status());
    return this.status();
  }

  private stopProcess(): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    if (!child) return;
    try {
      child.kill();
    } catch {

    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (BASE64_LINE.test(line)) {
        this.frames += 1;
        this.seq += 1;
        this.lastFrameAt = new Date().toISOString();
        const frame: ScreenFrame = { seq: this.seq, ts: this.lastFrameAt, jpeg: line };
        this.emit("frame", frame);
      }
      index = this.buffer.indexOf("\n");
    }
    // защита от мусора без перевода строки
    if (this.buffer.length > 4_000_000) this.buffer = "";
  }
}
