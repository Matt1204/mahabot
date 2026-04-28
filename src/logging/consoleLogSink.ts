import type { LogEvent } from "./types.js";

export class ConsoleLogSink {
  constructor(private readonly consoleLike: Pick<Console, "debug" | "info" | "warn" | "error"> = console) {}

  write(event: LogEvent): void {
    const line = renderConsoleLine(event);
    switch (event.level) {
      case "debug":
        this.consoleLike.debug(line);
        return;
      case "info":
        this.consoleLike.info(line);
        return;
      case "warn":
        this.consoleLike.warn(line);
        return;
      case "error":
        this.consoleLike.error(line);
        return;
    }
  }
}

function renderConsoleLine(event: LogEvent): string {
  const parts = [
    new Date(event.ts).toISOString(),
    event.level.toUpperCase(),
    event.event,
    event.sessionId ? `session=${event.sessionId}` : "",
    event.turnId ? `turn=${event.turnId}` : "",
    event.summary,
  ].filter(Boolean);

  return `[mahabot] ${parts.join(" ")}`;
}
