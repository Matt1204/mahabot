import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { UserToAgentPart } from "../../messageBus/types.js";

export interface TelegramPhotoSizeLike {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramPhotoMessageLike {
  message_id: number;
  photo: TelegramPhotoSizeLike[];
  caption?: string;
  media_group_id?: string;
}

export interface TelegramVoiceLike {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoiceMessageLike {
  message_id: number;
  voice: TelegramVoiceLike;
}

export interface StoredTelegramVoice {
  path: string;
  mimeType?: string;
  duration?: number;
  fileSize?: number;
}

export class TelegramMediaStore {
  private readonly fetchImpl: typeof fetch;
  private readonly safeSessionId: string;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      persistenceRoot: string;
      sessionId: string;
      telegram: { getFileLink(fileId: string): Promise<URL> };
      fetch?: typeof fetch;
      now?: () => number;
    }
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.safeSessionId = sanitizePathSegment(options.sessionId);
    this.now = options.now ?? (() => Date.now());
  }

  async savePhoto(message: TelegramPhotoMessageLike): Promise<UserToAgentPart & { type: "image" }> {
    const selected = selectLargestPhoto(message.photo);
    if (!selected) {
      throw new Error("Telegram photo message does not contain any photo sizes.");
    }

    const fileUrl = await this.options.telegram.getFileLink(selected.file_id);
    const bytes = await this.downloadFile(fileUrl);
    const path = resolve(
      this.options.persistenceRoot,
      "media",
      this.safeSessionId,
      "images",
      `${this.now()}_${message.message_id}_${sanitizePathSegment(selected.file_unique_id)}.jpg`
    );

    await writeBinaryFile(path, bytes);

    return {
      type: "image",
      source: "local_file",
      path,
      mimeType: "image/jpeg",
      caption: message.caption,
      width: selected.width,
      height: selected.height,
      telegram: {
        fileId: selected.file_id,
        fileUniqueId: selected.file_unique_id,
        messageId: message.message_id,
        mediaGroupId: message.media_group_id,
      },
    };
  }

  async saveVoiceTemp(message: TelegramVoiceMessageLike): Promise<StoredTelegramVoice> {
    const fileUrl = await this.options.telegram.getFileLink(message.voice.file_id);
    const bytes = await this.downloadFile(fileUrl);
    const extension = voiceExtensionFromMimeType(message.voice.mime_type);
    const path = resolve(
      this.options.persistenceRoot,
      "tmp",
      this.safeSessionId,
      "voice",
      `${this.now()}_${message.message_id}_${sanitizePathSegment(message.voice.file_unique_id)}${extension}`
    );

    await writeBinaryFile(path, bytes);

    return {
      path,
      mimeType: message.voice.mime_type,
      duration: message.voice.duration,
      fileSize: message.voice.file_size,
    };
  }

  async deleteFiles(paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }

  private async downloadFile(url: URL): Promise<Uint8Array> {
    if (url.protocol === "file:") {
      return readFile(fileURLToPath(url));
    }

    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}

function selectLargestPhoto(
  photos: TelegramPhotoSizeLike[]
): TelegramPhotoSizeLike | undefined {
  return [...photos].sort((left, right) => {
    const leftScore = left.width * left.height;
    const rightScore = right.width * right.height;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return (right.file_size ?? 0) - (left.file_size ?? 0);
  })[0];
}

async function writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function voiceExtensionFromMimeType(mimeType: string | undefined): string {
  if (mimeType === "audio/mpeg") {
    return ".mp3";
  }
  if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") {
    return ".m4a";
  }
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    return ".wav";
  }
  return ".oga";
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/_+/g, "_");
  return sanitized || "media";
}
