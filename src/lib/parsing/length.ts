// Length parsing: the length_text a customer wrote, to feet as a number.
//
// Accepted forms (case-insensitive, straight or curly quote marks):
//   40'   40 ft   40ft   40 ft.   40 feet   40 foot   40 lf      feet
//   40-0   40'-0"   40' 0"   40'0   20'6"   20'-6"   20 ft 6 in   feet and inches
//   480"   480 in   480 inches                                     inches, divided by 12
//   24   24.5   .5   12-1/2'   12½'   12 1⁄2'                        bare number means feet;
//                                                                  fractions via parseFraction
// The fraction slash U+2044 (Outlook, Word) reads as "/", the same as in
// parseFraction.
// A leading "x", "@", or "at" and a trailing "length(s)", "long", "lg", "ea",
// or "each" are ignored ("x 40'", "at 40 ft", "40' lengths").
//
// Returns null for blank text, words ("random", "stock", "x"), metric or any
// unit it does not know, two lengths in one string ("40' or 48'"), a bare
// feet-inches pair whose inch part is 12 or more ("40 - 20" is a length and a
// count, not 41.67 ft), and anything that is not positive. Never throws and
// never guesses: null here becomes the missing_length flag, not a default.

import { parseFraction } from "@/lib/catalog/normalize";

const VULGAR = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
// An ASCII fraction with the ordinary slash or the fraction slash U+2044.
const FRACTION = "\\d+[\\/\\u2044]\\d+";
/**
 * Regex source (non-capturing) for one quantity parseFraction can read: whole,
 * decimal ("24.5" or ".5"), fraction, or mixed number (hyphen or space, ASCII
 * or vulgar glyph). Exported so src/lib/parsing/normalize.ts builds its
 * raw_text length token from this grammar and the two cannot drift: a narrower
 * grammar there once read "12 1/2'" as "1/2'".
 */
export const LENGTH_QUANTITY = `(?:(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[-\\s]+${FRACTION}|[-\\s]*[${VULGAR}])?|${FRACTION}|[${VULGAR}])`;
const Q = `(${LENGTH_QUANTITY})`;
const FEET = `(?:'|ft\\.?|feet|foot|lf|lin\\.?\\s*ft\\.?|linear\\s+feet)`;
const INCH = `(?:"|in\\.?|inch|inches)`;

const BARE = new RegExp(`^${Q}$`);
const FEET_INCHES = new RegExp(`^${Q}\\s*${FEET}(?:\\s*-?\\s*${Q}\\s*${INCH}?)?$`);
const INCHES_ONLY = new RegExp(`^${Q}\\s*${INCH}$`);
const HYPHEN_FEET_INCHES = new RegExp(`^(\\d+)\\s*-\\s*${Q}$`);

const LEADING_NOISE = /^(?:x|@|at)\s+/;
const TRAILING_NOISE = /\s+(?:lengths?|long|lg|lgths?|ea|each)\.?$/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/''/g, '"')
    .replace(/\u2044/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_NOISE, "")
    .replace(TRAILING_NOISE, "")
    .replace(/\.$/, "")
    .trim();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function positive(n: number | null): number | null {
  return n !== null && Number.isFinite(n) && n > 0 ? round4(n) : null;
}

function feetAndInches(feetText: string, inchText: string | undefined): number | null {
  const feet = parseFraction(feetText);
  if (feet === null) return null;
  if (inchText === undefined) return positive(feet);
  const inches = parseFraction(inchText);
  if (inches === null) return null;
  return positive(feet + inches / 12);
}

/**
 * Parse a length written in shop language to feet. See the module header for
 * the accepted forms. Returns null when the text cannot be read with certainty.
 */
export function parseLengthFt(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const s = normalize(text);
  if (s === "") return null;

  const bare = BARE.exec(s);
  if (bare) return positive(parseFraction(bare[1]));

  const ftIn = FEET_INCHES.exec(s);
  if (ftIn) return feetAndInches(ftIn[1], ftIn[2]);

  const inchesOnly = INCHES_ONLY.exec(s);
  if (inchesOnly) {
    const inches = parseFraction(inchesOnly[1]);
    return inches === null ? null : positive(inches / 12);
  }

  const hyphen = HYPHEN_FEET_INCHES.exec(s);
  if (hyphen) {
    const inches = parseFraction(hyphen[2]);
    if (inches === null || inches >= 12) return null;
    return positive(Number(hyphen[1]) + inches / 12);
  }

  return null;
}
