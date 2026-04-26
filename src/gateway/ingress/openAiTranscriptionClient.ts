import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export class OpenAiTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiTranscriptionError";
  }
}

export interface OpenAiTranscriptionClientOptions {
  apiKey: string;
  model: string;
  prompt: string;
  fetch?: typeof fetch;
}

export class OpenAiTranscriptionClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiTranscriptionClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async transcribe(filePath: string): Promise<string> {
    const fileBytes = await readFile(filePath);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileBytes], { type: "audio/mpeg" }),
      basename(filePath)
    );
    formData.append("model", this.options.model);
    formData.append("response_format", "json");
    formData.append("prompt", this.options.prompt);

    const response = await this.fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OpenAiTranscriptionError(
        `OpenAI transcription failed with HTTP ${response.status}${body ? `: ${body}` : ""}`
      );
    }

    const payload = await response.json() as unknown;
    const text = extractTranscriptText(payload).trim();
    if (!text) {
      throw new OpenAiTranscriptionError("OpenAI transcription returned an empty transcript.");
    }

    return text;
  }
}

function extractTranscriptText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }

  return "";
}
