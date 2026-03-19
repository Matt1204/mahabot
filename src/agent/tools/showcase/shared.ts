import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function textAndImageResult<TDetails>(
  text: string,
  base64Png: string,
  details: TDetails
): AgentToolResult<TDetails> {
  return {
    content: [
      { type: "text", text },
      { type: "image", data: base64Png, mimeType: "image/png" },
    ],
    details,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function demoGeneratePngBase64(): string {
  // 1x1 transparent PNG
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlH0acAAAAASUVORK5CYII=";
}
