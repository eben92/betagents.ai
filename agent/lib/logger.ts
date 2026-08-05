/**
 * Structured logging with mandatory secret redaction.
 *
 * Operator credentials, API keys and bot tokens must never reach stdout, Google
 * Sheets, Telegram or a model prompt. Redaction happens here rather than at each
 * call site so a new logging statement cannot silently leak one.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Env vars whose values are scrubbed from every log line and error message.
 *
 * Matched by pattern rather than by name, because provider keys are named by
 * whoever configures them: a model can be pointed at any OpenAI-compatible
 * endpoint via `<NAME>_API_KEY`, and a fixed list would silently miss it.
 */
const SECRET_ENV_PATTERN =
  /(^|_)(API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS?)($|_)/i;

/** Secret-bearing vars whose names do not match the pattern above. */
const SECRET_ENV_KEYS = ["OPERATOR_USERNAME", "GOOGLE_PRIVATE_KEY"];

function secretEnvKeys(): string[] {
  const keys = new Set(SECRET_ENV_KEYS);
  for (const key of Object.keys(process.env)) {
    if (SECRET_ENV_PATTERN.test(key)) keys.add(key);
  }
  return [...keys];
}

/** Field names that are redacted wherever they appear in a logged object. */
const SECRET_FIELD_PATTERN = /^(password|passwd|secret|token|apikey|api_key|authorization|cookie|private_key|privatekey)$/i;

const REDACTED = "[redacted]";

function activeSecrets(): string[] {
  const values: string[] = [];
  for (const key of secretEnvKeys()) {
    const value = process.env[key]?.trim();
    // Very short values would scrub harmless substrings out of unrelated text.
    if (value && value.length >= 6) values.push(value);
  }
  return values;
}

export function redactText(input: string): string {
  let output = input;
  for (const secret of activeSecrets()) {
    if (output.includes(secret)) output = output.split(secret).join(REDACTED);
  }
  return output;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_FIELD_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[configured] ?? LEVELS.info;
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const line: Record<string, unknown> = {
    at: new Date().toISOString(),
    level,
    scope,
    message: redactText(message),
  };
  if (fields && Object.keys(fields).length > 0) line.fields = redact(fields);
  const serialised = JSON.stringify(line);
  if (level === "error" || level === "warn") console.error(serialised);
  else console.log(serialised);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

/** Normalises any thrown value into a redacted, human-readable string. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactText(error.message);
  if (typeof error === "string") return redactText(error);
  try {
    return redactText(JSON.stringify(error));
  } catch {
    return "unknown error";
  }
}
