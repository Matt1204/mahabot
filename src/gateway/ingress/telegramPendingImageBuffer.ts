import type { UserToAgentPart } from "../../messageBus/types.js";

export type PendingImagePart = UserToAgentPart & { type: "image" };

export type PendingImageTakeResult =
  | { type: "empty"; images: [] }
  | { type: "ready"; images: PendingImagePart[] }
  | { type: "expired"; expiredImages: PendingImagePart[] };

interface PendingImageEntry {
  images: PendingImagePart[];
  expiresAt: number;
}

export class TelegramPendingImageBuffer {
  private readonly entries = new Map<string, PendingImageEntry>();
  private readonly now: () => number;

  constructor(
    private readonly options: {
      timeoutMs: number;
      now?: () => number;
    }
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  addImage(sessionId: string, image: PendingImagePart): void {
    const existing = this.entries.get(sessionId);
    const images = existing ? [...existing.images, image] : [image];
    this.entries.set(sessionId, {
      images,
      expiresAt: this.now() + this.options.timeoutMs,
    });
  }

  takeImages(sessionId: string, now = this.now()): PendingImageTakeResult {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return { type: "empty", images: [] };
    }

    this.entries.delete(sessionId);
    if (entry.expiresAt <= now) {
      return { type: "expired", expiredImages: entry.images };
    }

    return { type: "ready", images: entry.images };
  }

  clearExpired(sessionId: string, now = this.now()): PendingImageTakeResult | null {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.expiresAt > now) {
      return null;
    }

    this.entries.delete(sessionId);
    return { type: "expired", expiredImages: entry.images };
  }

  stop(): void {
    this.entries.clear();
  }
}
