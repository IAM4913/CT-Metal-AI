// Deterministic readers for the money, percentage, and date text a vendor
// writes in a reply (PRD section 13 B: the model copies the text, code
// computes). Every function here is pure, never throws, never returns NaN, and
// answers null for anything it cannot read with certainty. Nothing is
// defaulted: an unreadable price is null and the caller flags it.
//
//   parseMoney        "$64.50/cwt" -> 64.5, "$1,250" -> 1250, ".98" -> 0.98, "n/a" -> null
//   parsePercent      "1%" -> 1, "1 percent" -> 1, "0.5%" -> 0.5, "net 30" -> null
//   parseEarlyPay     "1% net 10" -> {1, 10}, "1/10 net 30" -> {1, 10}, "net 30" -> {null, null}
//   parseReadyDate    "week of Nov 17", "11/17", "Nov 17", "11/17/2026" -> that date; "ASAP" -> null
//   parseQuoteExpiry  "valid 7 days" -> reference + 7 days; "good through 11/30" -> that date
//
// Money: when the text carries a currency marker ($, US$, USD) the amount is
// read from the marker on, so a count or a length ahead of the price ("8 pcs
// $62.50 cwt", "40', $64.50/cwt") is never taken for it; without a marker the
// first number stands. A number the reader cannot be sure of is null rather
// than a wrong value: a decimal comma ("64,50"), a malformed thousands group
// ("$1,2500"), or a signed amount ("-$150 credit").
//
// Dates: a date written without a year takes the reference year, rolling to
// the next year only when that would put it more than 60 days before the
// reference (a vendor writing "Jan 5" in December means next month, one
// writing "Oct 1" on Oct 22 means the date just passed). An explicit year is
// four digits in 1900 to 2099 ending at a word boundary, so a weight or a
// footage after the day ("Nov 17 2000 lbs") is not a year, and an explicit date
// more than a year before the reference reads as null (not a date the vendor
// means today). Date-only values are built at 00:00 UTC so the stored day never
// shifts with the server's time zone; "valid N days" keeps the reference instant
// plus N days, and "valid N days from <date>" counts from that date.

import { addDays, differenceInDays, format } from "date-fns";

// A money or quantity number: optional thousands groups, optional decimals, or
// a bare fraction like .98. It may not start right after a digit, a separator,
// or a minus, and may not run on into more digits or a separator plus digit,
// so "64,50", "1.250,00", and "$1,2500" find no number instead of a truncated one.
const NUMBER = /(?<![\d.,-])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?!\d|[.,]\d)/;

// A minus attached to the digits or to the currency symbol ("-5", "-$150",
// "$-150", "credit -150.00"): a price is never negative, so the text is
// unreadable. A bulleted "- $64.50/cwt" (space after the dash) and a range
// digit like "1-2 trucks" (digit before the dash) are not signs.
const SIGNED_AMOUNT = /(?<![\w)])-\$?(?:\d|\.\d)|\$-(?:\d|\.\d)/;

// Where the price starts when the text names its currency.
const CURRENCY_MARKER = /\$|\bUSD?\b/i;

// A number followed by a percent word: "1%", "1 %", "1 percent", "0.5 pct".
const PERCENT = /(\d+(?:\.\d+)?|\.\d+)\s*(?:%|percent\b|pct\b)/i;

// "1/10 net 30", "2/10, n/30": discount pct over days, the classic trade form.
// Not preceded by a digit or a slash and not followed by a slash, so a date
// like 10/17/2026 cannot read as terms.
const SLASH_TERMS = /(?<![\d/])(\d{1,2}(?:\.\d+)?)\s*\/\s*(\d{1,3})(?![\d/])/g;

// The terms markers a slash pair must sit beside when the text is a whole
// payment-terms phrase (slashNeedsNet): "terms 2/10 ..." or "2/10 net 30",
// "2/10, n/30". A month/day like "due 11/30" or "from 10/22" has neither.
const TERMS_WORD_BEFORE = /\bterms?\s*:?\s*$/i;
const NET_AFTER = /^\s*,?\s*(?:net|n\/?)\s*\d/i;

// The first number after the percent, read as the discount window in days when
// it is not itself a percent and no net-only phrasing stands between.
const DAYS_AFTER = /^[^\d%]{0,40}?(\d{1,3})(?!\s*(?:%|percent\b|pct\b|\.\d))/i;

const MONTHS: ReadonlyMap<string, number> = new Map([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

const MONTH_WORD = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
// A four-digit year in 1900 to 2099 that ends at a word boundary: "2000 lbs"
// after "Nov 17" is a weight, "2000lbs" is not a year either, "1000 ft" is footage.
const YEAR = "(?:,?\\s*((?:19|20)\\d{2})\\b)?";

const MONTH_DAY = new RegExp(`\\b${MONTH_WORD}\\s+${DAY}\\b${YEAR}`, "i");
const DAY_MONTH = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH_WORD}\\b${YEAR}`, "i");
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

// "valid 7 days", "good for 10 days", "firm for 2 weeks", "valid thirty days" (words are not read).
const DAYS_WINDOW = /\b(\d{1,3})\s*(?:business\s+|working\s+)?days?\b/i;
const WEEKS_WINDOW = /\b(\d{1,2})\s*weeks?\b/i;

// "valid 30 days from 10/22/2026", "dated Oct 22": the words that make a named
// date the start of a window rather than its end.
const WINDOW_ANCHOR_BEFORE = /\b(?:from|dated|as of|starting|beginning)\b[^\d]*$/i;

/** The year a date without one takes: the reference year, or the next when the date would sit more than 60 days back. */
const ROLL_BACK_DAYS = 60;

/** An explicit date this many days or more before the reference is not one the vendor means today. */
const STALE_DATE_DAYS = 366;

function clean(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

function validReference(reference: Date): boolean {
  return reference instanceof Date && !Number.isNaN(reference.getTime());
}

/**
 * The money amount in the text, read from the first currency marker when there
 * is one ("8 pcs $62.50 cwt" 62.5, "40', $64.50/cwt" 64.5, "USD 64.5 per cwt"
 * 64.5) and from the first number otherwise ("64.50/cwt" 64.5, ".98" 0.98,
 * "1,250 each" 1250). Thousands separators and the basis fragment are ignored.
 * Null for "n/a", "included", "TBD", blank, anything with no number in it, a
 * signed amount ("-$150"), or a number that cannot be read with certainty
 * ("64,50", "$1,2500"). Never NaN, never throws.
 */
export function parseMoney(text: string | null | undefined): number | null {
  const s = clean(text);
  if (s === null) return null;
  if (SIGNED_AMOUNT.test(s)) return null;
  const at = s.search(CURRENCY_MARKER);
  const from = at >= 0 ? s.slice(at) : s;
  const match = NUMBER.exec(from);
  if (!match) return null;
  return finite(Number(match[1].replace(/,/g, "")));
}

/**
 * The first percentage in the text: "1%" 1, "1 percent" 1, "0.5%" 0.5,
 * "1% net 10" 1. Null when no number carries a percent word ("net 30").
 */
export function parsePercent(text: string | null | undefined): number | null {
  const s = clean(text);
  if (s === null) return null;
  const match = PERCENT.exec(s);
  if (!match) return null;
  return finite(Number(match[1]));
}

export type EarlyPayOptions = {
  /**
   * The text is a whole payment-terms phrase, so the slash form counts only
   * beside a terms marker ("terms 2/10", "2/10 net 30", "2/10, n/30"). A
   * month/day in the phrase ("Net 30, due 11/30", "1/2 down") then reads as
   * nothing instead of as an 11 percent discount at 30 days.
   */
  slashNeedsNet?: boolean;
};

/**
 * Early-pay terms: the discount percentage and the number of days to earn it.
 *   "1% net 10"    {1, 10}      "1% 10 days"  {1, 10}
 *   "1/10 net 30"  {1, 10}      "2% 10"       {2, 10}
 *   "net 30"       {null, null} "1%"          {1, null}
 * The percent form is read first; the days are the first number after it that
 * is not itself a percent. The slash form (pct/days) is read when no percent
 * word appears, and with slashNeedsNet only beside a terms marker. Nothing is
 * defaulted: a discount with no window keeps days null.
 */
export function parseEarlyPay(
  text: string | null | undefined,
  options: EarlyPayOptions = {},
): { pct: number | null; days: number | null } {
  const s = clean(text);
  if (s === null) return { pct: null, days: null };

  const percent = PERCENT.exec(s);
  if (percent) {
    const pct = finite(Number(percent[1]));
    const rest = s.slice(percent.index + percent[0].length);
    const days = DAYS_AFTER.exec(rest);
    return { pct, days: days ? finite(Number(days[1])) : null };
  }

  SLASH_TERMS.lastIndex = 0;
  for (let slash = SLASH_TERMS.exec(s); slash !== null; slash = SLASH_TERMS.exec(s)) {
    const marked =
      !options.slashNeedsNet ||
      TERMS_WORD_BEFORE.test(s.slice(0, slash.index)) ||
      NET_AFTER.test(s.slice(slash.index + slash[0].length));
    if (marked) {
      SLASH_TERMS.lastIndex = 0;
      return { pct: finite(Number(slash[1])), days: finite(Number(slash[2])) };
    }
  }

  return { pct: null, days: null };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls Feb 30 into March; refuse anything that moved.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function fullYear(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return text.length === 2 ? 2000 + n : n;
}

/**
 * A month and day without a year take the reference year unless that lands
 * more than 60 days before the reference, in which case the next year.
 */
function withInferredYear(month: number, day: number, reference: Date): Date | null {
  const sameYear = utcDate(reference.getUTCFullYear(), month, day);
  if (sameYear === null) return null;
  if (differenceInDays(reference, sameYear) > ROLL_BACK_DAYS) {
    return utcDate(reference.getUTCFullYear() + 1, month, day);
  }
  return sameYear;
}

/** A date with its own year stands only when it is not more than a year before the reference. */
function withExplicitYear(year: number, month: number, day: number, reference: Date): Date | null {
  const date = utcDate(year, month, day);
  if (date === null) return null;
  return differenceInDays(reference, date) >= STALE_DATE_DAYS ? null : date;
}

type DateMention = { date: Date; index: number };

/** The first calendar date in the text with where it starts (see parseDateMention). */
function findDateMention(s: string, reference: Date): DateMention | null {
  const iso = ISO_DATE.exec(s);
  if (iso) {
    const date = withExplicitYear(Number(iso[1]), Number(iso[2]), Number(iso[3]), reference);
    return date === null ? null : { date, index: iso.index };
  }

  const numeric = NUMERIC_DATE.exec(s);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    const year = fullYear(numeric[3]);
    const date = year === null ? withInferredYear(month, day, reference) : withExplicitYear(year, month, day, reference);
    return date === null ? null : { date, index: numeric.index };
  }

  const monthDay = MONTH_DAY.exec(s);
  if (monthDay) {
    const month = MONTHS.get(monthDay[1].toLowerCase()) ?? 0;
    const day = Number(monthDay[2]);
    const year = fullYear(monthDay[3]);
    const date = year === null ? withInferredYear(month, day, reference) : withExplicitYear(year, month, day, reference);
    return date === null ? null : { date, index: monthDay.index };
  }

  const dayMonth = DAY_MONTH.exec(s);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = MONTHS.get(dayMonth[2].toLowerCase()) ?? 0;
    const year = fullYear(dayMonth[3]);
    const date = year === null ? withInferredYear(month, day, reference) : withExplicitYear(year, month, day, reference);
    return date === null ? null : { date, index: dayMonth.index };
  }

  return null;
}

/**
 * The first calendar date in the text, in any of these spellings: "Nov 17",
 * "November 17th, 2026", "17 Nov", "11/17", "11/17/26", "11/17/2026",
 * "2026-11-17". Null when the text names no specific day ("mid November",
 * "December", "ASAP", "stock") or names a date with an explicit year more than
 * a year before the reference. A missing year is inferred from the reference.
 */
export function parseDateMention(text: string | null | undefined, reference: Date): Date | null {
  const s = clean(text);
  if (s === null || !validReference(reference)) return null;
  return findDateMention(s, reference)?.date ?? null;
}

/**
 * The ready-to-ship date a vendor names: "week of Nov 17" and "11/17" are Nov
 * 17 of the reference year (next year only when that date is more than 60 days
 * before the reference), "11/17/2026" and "Nov 17, 2026" are that date. Null
 * for anything without a specific day ("mid November", "ASAP", "stock",
 * "2 to 3 weeks"): the text stays beside the line for the reviewer instead.
 */
export function parseReadyDate(text: string | null | undefined, reference: Date): Date | null {
  return parseDateMention(text, reference);
}

/** The window in days a validity phrase states ("valid 7 days" 7, "firm for 2 weeks" 14), or null. */
function windowDays(s: string): number | null {
  const days = DAYS_WINDOW.exec(s);
  if (days) {
    const n = Number(days[1]);
    return n > 0 ? n : null;
  }
  const weeks = WEEKS_WINDOW.exec(s);
  if (weeks) {
    const n = Number(weeks[1]);
    return n > 0 ? n * 7 : null;
  }
  return null;
}

/**
 * When a quote stops being good. A named date ("good through 11/30", "expires
 * Nov 30, 2026") is the expiry, unless a window is stated as well and the
 * named date is the quote's own date (not after the reference, or introduced
 * by "from", "dated", "as of"), in which case the window counts from that date
 * ("valid 30 days from 10/22/2026" is Nov 21). A window alone counts from the
 * reference ("valid 7 days" is reference + 7 days, "firm for 2 weeks" + 14).
 * Null for anything else ("subject to change", "until sold", blank).
 */
export function parseQuoteExpiry(text: string | null | undefined, reference: Date): Date | null {
  const s = clean(text);
  if (s === null || !validReference(reference)) return null;

  const named = findDateMention(s, reference);
  const window = windowDays(s);

  if (named !== null) {
    const anchored =
      window !== null &&
      (named.date.getTime() <= reference.getTime() || WINDOW_ANCHOR_BEFORE.test(s.slice(0, named.index)));
    return anchored ? addDays(named.date, window) : named.date;
  }

  return window === null ? null : addDays(reference, window);
}

// ---------------------------------------------------------------------------
// Calendar days
// ---------------------------------------------------------------------------

/** yyyy-MM-dd in UTC, the form offer_lines.ready_date (a date column) stores. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The UTC calendar day of a stored timestamp, as yyyy-MM-dd:
 * "2026-11-30T00:00:00.000Z" is "2026-11-30" in every time zone. The day a
 * date-only value was stored at (00:00 UTC) is the day it means; reading it
 * through the browser's zone would show the previous day west of Greenwich.
 * Null for an unreadable timestamp.
 */
export function isoDayOf(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : toIsoDate(date);
}

/**
 * A yyyy-MM-dd day formatted for display ("Nov 30, 2026") from its own
 * components, so the day shown is the day stored whatever the local zone.
 * Null when the text is not a yyyy-MM-dd day.
 */
export function formatIsoDay(day: string | null | undefined, pattern = "MMM d, yyyy"): string | null {
  if (typeof day !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) return null;
  const [year, month, dayOfMonth] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const local = new Date(year, month - 1, dayOfMonth);
  // new Date() rolls Feb 30 into March; refuse anything that moved.
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== dayOfMonth) return null;
  return format(local, pattern);
}
