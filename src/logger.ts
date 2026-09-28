/**
 * Structured logging for the notifier.
 *
 * The process emits two kinds of thing: operator-facing progress (`[boot]`,
 * `[poller]`, `[shutdown]` lines) and operational failures. Both used to be plain
 * `console.*` strings, which read well but cannot be filtered by level, cannot
 * be aggregated, and must be re-parsed by whoever is on call.
 *
 * This module keeps the strings and adds the structure. Every call site passes
 * the human line it already printed as `message`, plus the values it already had
 * in scope as `fields`. With `MIMIR_LOG_FORMAT=text` (the default) the process
 * emits exactly what it emitted before; with `MIMIR_LOG_FORMAT=json` it emits
 * one JSON object per line carrying the same information.
 *
 * Secrets do not reach a sink. The configured bot token is registered through
 * `configure({ secrets })`, and the Telegram token *shape* is redacted even when
 * the caller does not hold the value — a unit test, or the process handlers in
 * `index.ts`, which are installed before config is loaded.
 *
 * Dependency-free on purpose: this is the module that reports a failed boot, so
 * it must not be able to fail one.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** Ordered so a threshold comparison is a single number compare. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export const LOG_LEVELS: readonly LogLevel[] = Object.keys(LEVEL_RANK) as LogLevel[];

/** Records below this are dropped. `info` keeps the whole boot/ops line set. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export type LogFormat = "text" | "json";

/** Human lines unless asked otherwise; a JSON sink is a deployment choice. */
export const DEFAULT_LOG_FORMAT: LogFormat = "text";

/** Environment variable names, read here so no config schema change is needed. */
export const LOG_LEVEL_ENV = "MIMIR_LOG_LEVEL";
export const LOG_FORMAT_ENV = "MIMIR_LOG_FORMAT";

/** Unrecognised input falls back to the default rather than silencing logs. */
export function parseLogLevel(raw: string | undefined | null): LogLevel {
  const value = (raw ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, value)
    ? (value as LogLevel)
    : DEFAULT_LOG_LEVEL;
}

export function parseLogFormat(raw: string | undefined | null): LogFormat {
  return (raw ?? "").trim().toLowerCase() === "json" ? "json" : DEFAULT_LOG_FORMAT;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}

/** `123456:ABC…`, the shape of a Telegram bot token. */
const TELEGRAM_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g;

const REDACTED = "[REDACTED]";

/** Fields are bounded so one remote value cannot size a log line. */
export const MAX_LOG_FIELD_CHARS = 512;
const MAX_LOG_DEPTH = 4;

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Literal values to redact wherever they appear, e.g. the bot token. */
  secrets?: readonly string[];
  /** Where a rendered line goes. Defaults to `console.log`/`warn`/`error`. */
  sink?: (level: LogLevel, line: string) => void;
  /** Injectable clock, so a test can assert `ts` without freezing time. */
  now?: () => Date;
}

function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out.replace(TELEGRAM_TOKEN, REDACTED);
}

function redactValue(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof value === "string") {
    const redacted = redactText(value, secrets);
    return redacted.length <= MAX_LOG_FIELD_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_LOG_FIELD_CHARS - 1)}…`;
  }
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  // `JSON.stringify` drops `undefined` and functions on its own; anything else
  // that reaches here is a container we recurse into, depth-limited so a cyclic
  // or pathological field cannot hang the logger.
  if (depth >= MAX_LOG_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactValue(item, secrets, depth + 1);
  }
  return out;
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error" || level === "fatal") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

/**
 * A tiny level-filtered, redacting logger.
 *
 * Static because a notifier is a single process with a single log stream: a
 * module-level sink keeps every call site (`index.ts`, `poller.ts`, and the
 * exported cursor helper) writing to the same place without threading a handle
 * through every constructor.
 */
export class Logger {
  private static level: LogLevel = DEFAULT_LOG_LEVEL;
  private static format: LogFormat = DEFAULT_LOG_FORMAT;
  private static secrets: readonly string[] = [];
  private static sink: ((level: LogLevel, line: string) => void) | null = null;
  private static clock: () => Date = () => new Date();

  /** Apply any subset of the options; unspecified ones are left alone. */
  static configure(options: LoggerOptions = {}): void {
    if (options.level !== undefined) Logger.level = options.level;
    if (options.format !== undefined) Logger.format = options.format;
    if (options.secrets !== undefined) Logger.secrets = [...options.secrets];
    if (options.sink !== undefined) Logger.sink = options.sink;
    if (options.now !== undefined) Logger.clock = options.now;
  }

  /** Configure level and format from the environment, as the process does. */
  static configureFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    Logger.level = parseLogLevel(env[LOG_LEVEL_ENV]);
    Logger.format = parseLogFormat(env[LOG_FORMAT_ENV]);
  }

  /** Drop every override. For tests, and for a fresh process in a forked child. */
  static reset(): void {
    Logger.level = DEFAULT_LOG_LEVEL;
    Logger.format = DEFAULT_LOG_FORMAT;
    Logger.secrets = [];
    Logger.sink = null;
    Logger.clock = () => new Date();
  }

  static isEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[Logger.level];
  }

  static getLevel(): LogLevel {
    return Logger.level;
  }

  static getFormat(): LogFormat {
    return Logger.format;
  }

  static debug(component: string, message: string, fields?: Record<string, unknown>): void {
    Logger.write("debug", component, message, fields);
  }

  static info(component: string, message: string, fields?: Record<string, unknown>): void {
    Logger.write("info", component, message, fields);
  }

  static warn(component: string, message: string, fields?: Record<string, unknown>): void {
    Logger.write("warn", component, message, fields);
  }

  static error(component: string, message: string, fields?: Record<string, unknown>): void {
    Logger.write("error", component, message, fields);
  }

  static fatal(component: string, message: string, fields?: Record<string, unknown>): void {
    Logger.write("fatal", component, message, fields);
  }

  /** Render one record and hand it to the sink. Never throws. */
  static write(
    level: LogLevel,
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (!Logger.isEnabled(level)) return;
    let line: string;
    try {
      line = Logger.render(level, component, message, fields);
    } catch {
      // A field that cannot be serialized must not take the log call down with
      // it: fall back to the message alone, redacted as usual.
      line = redactText(message, Logger.secrets);
    }
    (Logger.sink ?? defaultSink)(level, line);
  }

  private static render(
    level: LogLevel,
    component: string,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    if (Logger.format === "text") return redactText(message, Logger.secrets);
    const record: Record<string, unknown> = {};
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = redactValue(value, Logger.secrets, 0);
      }
    }
    // Canonical keys win over a same-named field, so a caller cannot shadow the
    // level or the component it is logging as.
    record.ts = Logger.clock().toISOString();
    record.level = level;
    record.component = component;
    record.msg = redactText(message, Logger.secrets);
    return JSON.stringify(record, (_key, value) => (value === undefined ? undefined : value));
  }
}

// The process configures itself on import, so a log emitted before `main()` runs
// still honours the deployment's level and format.
Logger.configureFromEnv();
