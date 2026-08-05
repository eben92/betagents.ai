/**
 * Timezone-aware date helpers built on `Intl`, with no date library.
 *
 * The betting day is defined by the configured IANA timezone, not by the host
 * clock, so a VPS running in UTC still rolls over at local midnight.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = partsCache.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timezone, cached);
  }
  return cached;
}

export function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatter(timezone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? "0";
    return Number.parseInt(value, 10);
  };
  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = read("hour") % 24;
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

function asUtcMs(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** Offset of `timezone` from UTC at `date`, in milliseconds. */
export function offsetMs(date: Date, timezone: string): number {
  return asUtcMs(zonedParts(date, timezone)) - date.getTime();
}

/**
 * Converts wall-clock parts in `timezone` to the matching UTC instant.
 * Refined once so daylight-saving transitions resolve to the correct side.
 */
export function zonedTimeToUtc(parts: ZonedParts, timezone: string): Date {
  const naive = asUtcMs(parts);
  const first = naive - offsetMs(new Date(naive), timezone);
  const refined = naive - offsetMs(new Date(first), timezone);
  return new Date(refined);
}

/** `YYYY-MM-DD` for the betting day containing `date`. */
export function dayKey(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function startOfDay(date: Date, timezone: string): Date {
  const parts = zonedParts(date, timezone);
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0, second: 0 }, timezone);
}

/** The next local midnight strictly after `date`. */
export function nextMidnight(date: Date, timezone: string): Date {
  const today = startOfDay(date, timezone);
  if (today.getTime() > date.getTime()) return today;
  // Step forward 26h to clear the longest DST shift, then snap to that day's start.
  return startOfDay(new Date(today.getTime() + 26 * 60 * 60 * 1000), timezone);
}

export function formatInZone(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60000;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000);
}

/** Parses an ISO timestamp, returning null rather than an Invalid Date. */
export function parseIso(value: string | undefined | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isoNow(): string {
  return new Date().toISOString();
}
