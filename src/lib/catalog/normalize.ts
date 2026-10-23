// Alias normalization and fraction handling for the catalog.
//
// normalizeAlias() turns shop language into one canonical string so that an
// alias stored on a catalog item and a phrase typed by a customer compare equal.
// It runs on every alias before it is stored and on every lookup key before it
// is matched, so both sides always see the same form. It is idempotent:
// normalizeAlias(normalizeAlias(x)) === normalizeAlias(x).
//
// Token table. Word rules apply to whole words only; letters glued to digits
// ("hss8x8x5/8", "c12x30", "pl3/8", "w12x26") are left alone so designations
// survive unchanged.
//
//   input                                     output
//   ------------------------------------------------------------------------
//   " (straight or curly) ″  in  inch  inches  dropped (inches are implied)
//   30#  30 #  30lb  lb  lbs  pound  pounds    "30 lb" (always a space before lb)
//   sq  square                                 sq
//   tube  tubing  hss                          hss
//   wall  wl                                   wall
//   plate  plt  pl                             plate
//   angle  ang  l                              angle
//   channel  chan  c                           channel
//   beam  wf  w                                beam
//   round  rnd  rd                             rd
//   gauge  gage  ga                            ga
//   schedule  sched  sch                       sch
//   x  X  by  × between two numbers            x with no spaces ("8 x 8" -> "8x8")
//   "1 1/2" as a standalone mixed number       "1-1/2" (the designation form)
//   ½ ¼ ¾ ⅛ ⅜ ⅝ ⅞ and the other Unicode        the ASCII fraction; a digit glued to
//   vulgar fractions, ⁄ (fraction slash)       the front makes a mixed number
//                                              ("1½" -> "1-1/2", "8x8x⅝" -> "8x8x5/8")
//   any other punctuation                      a space, except "/" and "-" between
//                                              digits (5/8, 1-1/2) and "." before a
//                                              digit (.375, 31.8, 8x8x.625) unless a
//                                              letter other than x precedes it
//                                              ("no.4" -> "no 4", "sch.40" -> "sch 40")
//   runs of whitespace                         one space, trimmed at both ends
//
// A "#" before a number ("#4 rebar") is a bar number, not a weight, and is
// dropped like other punctuation: "rebar#4" becomes "rebar 4". Only a "#" after
// a number means pounds per foot.
//
// Vulgar fraction characters are expanded before anything else so the fraction
// value is never lost: Outlook and Word AutoCorrect turn 1/2, 1/4, and 3/4 into
// ½, ¼, ¾ by default, and dropping them as punctuation would turn "1½ pipe std"
// into "1 pipe std", a confident wrong size instead of a miss.
//
// Mixed numbers inside an "x" chain ("2 1/2x2 1/2x1/4") are not rewritten,
// because "8x8 5/8 wall" (8x8 tube, 5/8 wall) and "2x2 1/2" (2 by 2-1/2) cannot
// be told apart without a size table. The catalog generator emits both the
// hyphen and the space spelling for those aliases instead.

const TOKEN_MAP: ReadonlyMap<string, string> = new Map([
  ["in", ""],
  ["inch", ""],
  ["inches", ""],
  ["lb", "lb"],
  ["lbs", "lb"],
  ["pound", "lb"],
  ["pounds", "lb"],
  ["sq", "sq"],
  ["square", "sq"],
  ["tube", "hss"],
  ["tubing", "hss"],
  ["hss", "hss"],
  ["wall", "wall"],
  ["wl", "wall"],
  ["plate", "plate"],
  ["plt", "plate"],
  ["pl", "plate"],
  ["angle", "angle"],
  ["ang", "angle"],
  ["l", "angle"],
  ["channel", "channel"],
  ["chan", "channel"],
  ["c", "channel"],
  ["beam", "beam"],
  ["wf", "beam"],
  ["w", "beam"],
  ["round", "rd"],
  ["rnd", "rd"],
  ["rd", "rd"],
  ["gauge", "ga"],
  ["gage", "ga"],
  ["ga", "ga"],
  ["schedule", "sch"],
  ["sched", "sch"],
  ["sch", "sch"],
]);

// Unicode vulgar fractions (U+00BC to U+00BE and U+2150 to U+215E) and the
// fraction slash U+2044. Expanded by expandVulgarFractions before any other rule.
const VULGAR_FRACTIONS: ReadonlyMap<string, string> = new Map([
  ["¼", "1/4"],
  ["½", "1/2"],
  ["¾", "3/4"],
  ["⅐", "1/7"],
  ["⅑", "1/9"],
  ["⅒", "1/10"],
  ["⅓", "1/3"],
  ["⅔", "2/3"],
  ["⅕", "1/5"],
  ["⅖", "2/5"],
  ["⅗", "3/5"],
  ["⅘", "4/5"],
  ["⅙", "1/6"],
  ["⅚", "5/6"],
  ["⅛", "1/8"],
  ["⅜", "3/8"],
  ["⅝", "5/8"],
  ["⅞", "7/8"],
]);
const VULGAR_FRACTION = new RegExp(`(\\d)?([${Array.from(VULGAR_FRACTIONS.keys()).join("")}])`, "g");
const FRACTION_SLASH = /\u2044/g;

const INCH_MARKS = /["“”″]/g;
const TIMES_SIGN = /×/g;
const HASH_AFTER_NUMBER = /(\d)\s*#/g;
const POUNDS_GLUED_TO_NUMBER = /(\d)(lbs?|pounds?)\b/g;
const WORD = /\b[a-z]+\b/g;
const TIMES_BETWEEN_NUMBERS = /(\d)\s*(?:x|by)\s*(?=[\d.])/g;
const STANDALONE_SPACED_MIXED = /(^|\s)(\d+) +(\d+\/\d+)(?=\s|$)/g;

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

// "1½" -> "1-1/2", "8x8x⅝" -> "8x8x5/8", "⅜" -> "3/8", "5⁄8" -> "5/8". A digit
// directly before the glyph is a whole number, so the pair becomes a mixed
// number in the designation form; "1 ½" becomes "1 1/2" and the standalone
// mixed-number rule in normalizeAlias (or parseFraction's MIXED) takes it from
// there. Pure ASCII in, pure ASCII out, so the pass is idempotent.
function expandVulgarFractions(s: string): string {
  return s.replace(FRACTION_SLASH, "/").replace(VULGAR_FRACTION, (_, d: string | undefined, f: string) => {
    const ascii = VULGAR_FRACTIONS.get(f) ?? f;
    return d ? `${d}-${ascii}` : ascii;
  });
}

// Every character that is not a letter, digit, or whitespace becomes a space,
// except "/" and "-" between digits and "." directly before a digit. A "." that
// follows a letter is an abbreviation point ("no.4", "sch.40"), not a decimal,
// unless the letter is the times "x" ("8x8x.625", "2x.154 pipe").
function stripPunctuation(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[a-z0-9\s]/.test(ch)) {
      out += ch;
      continue;
    }
    const prev = i > 0 ? s[i - 1] : "";
    const next = i + 1 < s.length ? s[i + 1] : "";
    if ((ch === "/" || ch === "-") && isDigit(prev) && isDigit(next)) {
      out += ch;
    } else if (ch === "." && isDigit(next) && !(isLetter(prev) && prev !== "x")) {
      out += ch;
    } else {
      out += " ";
    }
  }
  return out;
}

export function normalizeAlias(input: string): string {
  let s = expandVulgarFractions(input.toLowerCase());
  s = s.replace(TIMES_SIGN, " x ");
  s = s.replace(INCH_MARKS, " ");
  s = s.replace(HASH_AFTER_NUMBER, "$1 lb");
  s = s.replace(POUNDS_GLUED_TO_NUMBER, "$1 $2");
  s = stripPunctuation(s);
  s = s.replace(WORD, (w) => TOKEN_MAP.get(w) ?? w);
  s = s.replace(TIMES_BETWEEN_NUMBERS, "$1x");
  s = s.replace(STANDALONE_SPACED_MIXED, "$1$2-$3");
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Fractions
// ---------------------------------------------------------------------------

// Optional trailing inch marker: 5/8", 1-1/2 in, 3 inches, 3 in.
const TRAILING_INCH = /\s*(?:["“”″]|in|inch|inches)\.?\s*$/i;
const WHOLE = /^\d+$/;
const DECIMAL = /^(?:\d*\.\d+|\d+\.\d*)$/;
const FRACTION = /^(\d+)\/(\d+)$/;
const MIXED = /^(\d+)[-\s]+(\d+)\/(\d+)$/;

/**
 * Parse an inch dimension written as a whole number, decimal, fraction, or
 * mixed number: "5/8", "1-1/2", "1 1/2", "1/2", "0.25", ".375", "3", "3.0".
 * Unicode vulgar fractions are accepted in the same positions ("½", "1½",
 * "1 ½", "1-½"). Surrounding whitespace and one trailing inch marker are
 * allowed. Anything else (empty, words, negative, zero denominator, a foot mark
 * like 40') is null. Never throws, never guesses.
 */
export function parseFraction(input: string): number | null {
  if (typeof input !== "string") return null;
  const s = expandVulgarFractions(input).trim().replace(TRAILING_INCH, "").trim();
  if (s === "") return null;

  if (WHOLE.test(s)) return Number(s);
  if (DECIMAL.test(s)) return Number(s);

  const frac = FRACTION.exec(s);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    return den === 0 ? null : num / den;
  }

  const mixed = MIXED.exec(s);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    return den === 0 ? null : whole + num / den;
  }

  return null;
}

/**
 * Inverse of parseFraction for the common sixteenths: 0.625 -> "5/8",
 * 1.5 -> "1-1/2", 0.375 -> "3/8", 8 -> "8". Anything that is not a multiple of
 * 1/16 comes back as a trimmed decimal ("0.154", "31.8").
 */
export function formatFraction(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const sixteenths = n * 16;
  const k = Math.round(sixteenths);
  if (k >= 0 && Math.abs(sixteenths - k) < 1e-6) {
    const whole = Math.floor(k / 16);
    let num = k % 16;
    if (num === 0) return String(whole);
    let den = 16;
    while (num % 2 === 0) {
      num /= 2;
      den /= 2;
    }
    const frac = `${num}/${den}`;
    return whole === 0 ? frac : `${whole}-${frac}`;
  }
  return String(Number(n.toFixed(4)));
}
