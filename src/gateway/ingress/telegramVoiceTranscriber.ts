import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { convertVoiceToMp3 } from "./ffmpegAudioConverter.js";
import { OpenAiTranscriptionClient } from "./openAiTranscriptionClient.js";
import type { StoredTelegramVoice } from "./telegramMediaStore.js";

const OPENAI_AUDIO_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

export class TelegramVoiceTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramVoiceTranscriptionError";
  }
}

export interface TelegramVoiceTranscriberOptions {
  ffmpegCommand: string;
  transcription: {
    model: string;
    apiKeyEnvVar: string;
    prompt: string;
  };
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface TelegramVoiceTranscriptionResult {
  text: string;
  model: string;
  duration?: number;
  mimeType?: string;
  fileSize?: number;
}

export class TelegramVoiceTranscriber {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: TelegramVoiceTranscriberOptions) {
    this.env = options.env ?? process.env;
  }

  async transcribe(voice: StoredTelegramVoice): Promise<TelegramVoiceTranscriptionResult> {
    const apiKey = this.env[this.options.transcription.apiKeyEnvVar]?.trim();
    if (!apiKey) {
      throw new TelegramVoiceTranscriptionError(
        `Missing OpenAI transcription API key. Set environment variable '${this.options.transcription.apiKeyEnvVar}'.`
      );
    }

    const outputPath = replaceExtension(voice.path, ".mp3");

    try {
      await mkdir(dirname(outputPath), { recursive: true });
      await convertVoiceToMp3({
        ffmpegCommand: this.options.ffmpegCommand,
        inputPath: voice.path,
        outputPath,
      });

      const convertedStat = await stat(outputPath);
      if (convertedStat.size > OPENAI_AUDIO_UPLOAD_LIMIT_BYTES) {
        throw new TelegramVoiceTranscriptionError(
          "Voice message is too large after conversion for OpenAI transcription."
        );
      }

      const client = new OpenAiTranscriptionClient({
        apiKey,
        model: this.options.transcription.model,
        prompt: this.options.transcription.prompt,
        fetch: this.options.fetch,
      });
      const text = await client.transcribe(outputPath);

      return {
        text,
        model: this.options.transcription.model,
        duration: voice.duration,
        mimeType: voice.mimeType,
        fileSize: voice.fileSize,
      };
    } finally {
      await Promise.all([
        rm(voice.path, { force: true }),
        rm(outputPath, { force: true }),
      ]);
    }
  }
}

function replaceExtension(path: string, extension: string): string {
  const withoutExtension = path.replace(/\.[^/.]+$/, "");
  return resolve(`${withoutExtension}.converted${extension}`);
}
