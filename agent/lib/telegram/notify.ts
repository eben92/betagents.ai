/**
 * Telegram reporting.
 *
 * Every report is written to the spreadsheet first and delivered second, so a
 * Telegram outage costs visibility but never history. Undelivered reports are
 * retried at the start of the next cycle.
 *
 * Messages are plain text: the channel sends without a parse mode, so there is
 * no markup to escape and no way for a team name to break a message.
 */

import { sendTelegramMessage } from "eve/channels/telegram";

import { getConfig } from "../config";
import { newId } from "../ids";
import { createLogger, errorMessage, redactText } from "../logger";
import { getStore, TAB, type ReportRecord } from "../sheets";

const log = createLogger("telegram:notify");

export type ReportKind =
  | "system"
  | "cycle_started"
  | "cycle_completed"
  | "research_started"
  | "research_completed"
  | "planner_started"
  | "planner_completed"
  | "reviewer_started"
  | "reviewer_approved"
  | "reviewer_rejected"
  | "balance"
  | "bet_drafted"
  | "bet_placed"
  | "bet_rejected"
  | "monitoring_started"
  | "live_update"
  | "settlement"
  | "daily_summary"
  | "error"
  | "needs_human";

const ICONS: Record<ReportKind, string> = {
  system: "⚙️",
  cycle_started: "▶️",
  cycle_completed: "✅",
  research_started: "🔎",
  research_completed: "📚",
  planner_started: "🧮",
  planner_completed: "🎯",
  reviewer_started: "🧐",
  reviewer_approved: "👍",
  reviewer_rejected: "🚫",
  balance: "💰",
  bet_drafted: "📝",
  bet_placed: "🎟️",
  bet_rejected: "❌",
  monitoring_started: "👀",
  live_update: "⚡",
  settlement: "🏁",
  daily_summary: "📊",
  error: "🔥",
  needs_human: "🆘",
};

/** Report kinds that are noise in normal operation unless verbose is on. */
const VERBOSE_ONLY: ReportKind[] = [
  "research_started",
  "planner_started",
  "reviewer_started",
  "cycle_started",
];

function verbose(): boolean {
  return (process.env.TELEGRAM_VERBOSE ?? "false").toLowerCase() === "true";
}

export interface ReportInput {
  kind: ReportKind;
  title: string;
  /** Rendered one per line under the title. Empty entries are dropped. */
  lines?: (string | null | undefined)[];
}

function render(input: ReportInput): string {
  const head = `${ICONS[input.kind] ?? "•"} ${input.title}`;
  const body = (input.lines ?? []).filter((line): line is string => Boolean(line && line.trim()));
  return redactText([head, ...body].join("\n"));
}

/** Outbound transport, replaceable so tests can observe delivery. */
export type TelegramTransport = (text: string) => Promise<boolean>;

let transport: TelegramTransport | null = null;

export function setTelegramTransport(next: TelegramTransport | null): void {
  transport = next;
}

/** Telegram's hard limit on one message. */
const MAX_MESSAGE_CHARS = 4096;

/**
 * Splits a report at line boundaries so a long one arrives as several readable
 * messages rather than being rejected whole.
 *
 * A cycle report names every match that was not backed, so on a full card it
 * comfortably exceeds the limit — and a report that fails to send is the one
 * failure mode this system cannot tolerate, because it is how the operator
 * stops knowing what their money is doing.
 */
export function chunkMessage(text: string, limit = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const line of text.split("\n")) {
    // A single line longer than the limit is split on width; nothing else can
    // be done with it, and dropping it would lose the reason for a rejection.
    if (line.length > limit) {
      flush();
      for (let index = 0; index < line.length; index += limit) {
        chunks.push(line.slice(index, index + limit));
      }
      continue;
    }
    if (current.length + line.length + 1 > limit) flush();
    current = current ? `${current}\n${line}` : line;
  }

  flush();
  return chunks;
}

async function sendOne(text: string): Promise<boolean> {
  if (transport) return transport(text);

  const config = getConfig();
  if (!config.telegram) {
    log.debug("telegram not configured; report not delivered");
    return false;
  }
  try {
    await sendTelegramMessage({
      credentials: { botToken: config.telegram.botToken },
      chatId: config.telegram.chatId,
      body: { text },
    });
    return true;
  } catch (error) {
    log.warn("telegram delivery failed", { error: errorMessage(error) });
    return false;
  }
}

async function deliver(text: string): Promise<boolean> {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    if (!(await sendOne(chunk))) return false;
  }
  return true;
}

/**
 * Records a report and attempts delivery. Never throws: reporting failures must
 * not be able to abort a betting cycle.
 */
export async function report(input: ReportInput): Promise<void> {
  if (VERBOSE_ONLY.includes(input.kind) && !verbose()) return;

  const text = render(input);
  const delivered = await deliver(text);

  try {
    const store = await getStore();
    const record: ReportRecord = {
      id: newId("rep"),
      createdAt: new Date().toISOString(),
      kind: input.kind,
      title: input.title,
      body: text,
      delivered,
    };
    await store.append(TAB.reports, record);
  } catch (error) {
    log.error("could not persist report", { error: errorMessage(error) });
  }
}

/** Records an error to the spreadsheet and raises it on Telegram. */
export async function reportError(scope: string, error: unknown, detail?: string): Promise<void> {
  const message = errorMessage(error);
  log.error("failure reported", { scope, error: message, detail });

  try {
    const store = await getStore();
    await store.append(TAB.errors, {
      id: newId("err"),
      createdAt: new Date().toISOString(),
      scope,
      message,
      detail: detail ? redactText(detail) : "",
      resolved: false,
    });
  } catch (storeError) {
    log.error("could not persist error record", { error: errorMessage(storeError) });
  }

  await report({ kind: "error", title: `Error in ${scope}`, lines: [message, detail] });
}

/** Escalation path for CAPTCHA, MFA and account restrictions. */
export async function reportNeedsHuman(scope: string, detail: string): Promise<void> {
  await report({
    kind: "needs_human",
    title: "Manual intervention required",
    lines: [
      `Stage: ${scope}`,
      detail,
      "Automation has stopped for this bet. Resolve it on the operator site, then send /resume.",
    ],
  });
}

/** Re-sends reports that were written while Telegram was unreachable. */
export async function flushUndelivered(limit = 10): Promise<number> {
  const config = getConfig();
  if (!config.telegram) return 0;

  try {
    const store = await getStore();
    const pending = (await store.list(TAB.reports))
      .filter((entry) => !entry.delivered)
      .slice(-limit);

    let sent = 0;
    for (const entry of pending) {
      if (await deliver(entry.body)) {
        await store.update(TAB.reports, entry.id, { delivered: true });
        sent += 1;
      } else {
        break; // Telegram is still down; stop hammering it.
      }
    }
    if (sent > 0) log.info("flushed pending reports", { sent });
    return sent;
  } catch (error) {
    log.warn("could not flush pending reports", { error: errorMessage(error) });
    return 0;
  }
}
