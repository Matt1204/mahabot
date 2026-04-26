import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class FfmpegUnavailableError extends Error {
  constructor(
    readonly command: string,
    readonly platform: NodeJS.Platform = process.platform
  ) {
    super(`ffmpeg is not available. ${ffmpegInstallHint(platform, command)}`);
    this.name = "FfmpegUnavailableError";
  }
}

export class FfmpegConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegConversionError";
  }
}

export async function assertFfmpegAvailable(ffmpegCommand: string): Promise<void> {
  try {
    await execFileAsync(ffmpegCommand, ["-version"], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new FfmpegUnavailableError(ffmpegCommand);
  }
}

export async function convertVoiceToMp3(input: {
  ffmpegCommand: string;
  inputPath: string;
  outputPath: string;
}): Promise<void> {
  await assertFfmpegAvailable(input.ffmpegCommand);

  try {
    await execFileAsync(
      input.ffmpegCommand,
      [
        "-y",
        "-i",
        input.inputPath,
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        input.outputPath,
      ],
      {
        timeout: 120000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }
    );
  } catch (error) {
    throw new FfmpegConversionError(`ffmpeg failed to convert Telegram voice: ${String(error)}`);
  }
}

export function ffmpegInstallHint(
  platform: NodeJS.Platform = process.platform,
  command = "ffmpeg"
): string {
  if (platform === "darwin") {
    return `Install it with 'brew install ffmpeg', or set ingress.telegram.media.ffmpegCommand if '${command}' is not on PATH.`;
  }

  if (platform === "win32") {
    return `Install it with 'winget install Gyan.FFmpeg' and ensure ffmpeg.exe is on PATH, or set ingress.telegram.media.ffmpegCommand.`;
  }

  return `Install it with your system package manager and ensure '${command}' is on PATH, or set ingress.telegram.media.ffmpegCommand.`;
}
