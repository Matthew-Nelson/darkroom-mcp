// stdout is the MCP stdio channel, so every log line goes to stderr.

type Level = "debug" | "info" | "warn" | "error";

export function log(level: Level, message: string, fields?: Record<string, unknown>): void {
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  process.stderr.write(`[darkroom] ${level}: ${line}\n`);
}
