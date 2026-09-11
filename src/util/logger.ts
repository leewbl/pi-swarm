/**
 * Structured runtime logger, separate from domain event streams.
 * Runtime/debug logs must never be appended to `events/*.jsonl` (PRD §13).
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  debug?: boolean;
  /** Custom sink; defaults to stderr so model context stays clean. */
  sink?: (line: string) => void;
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: "debug" | "info" | "warn" | "error", msg: string, fields?: LogFields) => {
    if (level === "debug" && !options.debug) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(fields ?? {}),
    });
    sink(line);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
