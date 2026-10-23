// Catalog generator: items plus rule-based aliases for every category in PRD
// AC-4.1. Pure data, no database access. scripts/seed.ts turns the output into
// catalog_items and catalog_aliases rows; generate.test.ts checks the invariants
// (unique designations, no alias shared by two items, weights against AISC).
//
// Designation formats (canonical everywhere, fractions are inches, mixed numbers
// use a hyphen):
//   HSS square        HSS8x8x5/8          HSS rectangular  HSS8x4x1/4
//   HSS round         HSS6x1/4 (nominal size x wall)
//   pipe              PIPE2STD, PIPE2XS, PIPE2XXS
//   W beam            W12x26              S beam           S12x31.8
//   channel           C12x30, MC12x31     angle            L2x2x1/4, L4x3x1/4 (long leg first)
//   flat bar          FB1/4x2 (t x w)     round bar        RB1, RB1-1/2
//   square bar        SQ1                 plate            PL3/8 (thickness only)
//   sheet             SH16GA              rebar            REBAR#4
//
// Bare "AxBxT" aliases: an angle owns the bare form of its own dims ("2x2x1/4"
// is L2x2x1/4). An HSS gets the bare form only when no angle in this catalog
// has the same dims ("8x8x5/8" is HSS8x8x5/8 because the 8x8 angles here are
// 3/4 and 1 only). Every other HSS alias carries a tube word or a wall word.

import type { MaterialCategory } from "@/lib/db/enums";
import { formatFraction, normalizeAlias } from "./normalize";

export type CatalogSeedItem = {
  category: MaterialCategory;
  designation: string;
  dims: Record<string, number | string>;
  weight_per_ft: number | null;
  default_grade: string | null;
  aliases: string[];
};

// ---------------------------------------------------------------------------
// Size tables (the common sizes a Texas broker sees, not the full AISC manual)
// ---------------------------------------------------------------------------

type SquareSize = { readonly size: number; readonly walls: readonly number[] };
type RectSize = { readonly a: number; readonly b: number; readonly walls: readonly number[] };
type RoundSize = { readonly nominal: number; readonly od: number; readonly walls: readonly number[] };
type PipeSize = {
  readonly nps: number;
  readonly od: number;
  readonly std: number;
  readonly xs: number;
  readonly xxs: number | null;
};
type DepthWeight = readonly [depth: number, weight: number];
type AngleEqual = { readonly leg: number; readonly thicknesses: readonly number[] };
type AngleUnequal = { readonly a: number; readonly b: number; readonly thicknesses: readonly number[] };
type FlatBarRow = { readonly t: number; readonly widths: readonly number[] };
type SheetGauge = { readonly gauge: number; readonly t: number; readonly lbPerSqft: number };
type RebarRow = { readonly bar: number; readonly d: number; readonly lbPerFt: number };

const HSS_SQUARE: readonly SquareSize[] = [
  { size: 2, walls: [1 / 8, 3 / 16, 1 / 4] },
  { size: 2.5, walls: [1 / 8, 3 / 16, 1 / 4, 5 / 16] },
  { size: 3, walls: [1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8] },
  { size: 3.5, walls: [1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8] },
  { size: 4, walls: [1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { size: 5, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { size: 6, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { size: 7, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { size: 8, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { size: 10, walls: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { size: 12, walls: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
];

const HSS_RECT: readonly RectSize[] = [
  { a: 3, b: 2, walls: [1 / 8, 3 / 16, 1 / 4] },
  { a: 4, b: 2, walls: [1 / 8, 3 / 16, 1 / 4, 5 / 16] },
  { a: 4, b: 3, walls: [1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8] },
  { a: 5, b: 3, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 6, b: 2, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8] },
  { a: 6, b: 3, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 6, b: 4, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 8, b: 4, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { a: 8, b: 6, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { a: 10, b: 4, walls: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { a: 10, b: 6, walls: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { a: 12, b: 4, walls: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { a: 12, b: 6, walls: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { a: 12, b: 8, walls: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
];

// Round HSS is designated by the nominal size a shop asks for ("8 round tube
// 3/8 wall" is HSS8x3/8), while weight and dims.od use the true outside
// diameter. The two differ only at 8: AISC rolls the 8 inch round at the pipe
// diameter 8.625 and lists no HSS8.000, so HSS8x3/8 is the 8.625 section
// (33.07 lb/ft, not 30.54). 3, 4, 5, 6, and 10 are true diameters (AISC lists
// HSS10.000 beside HSS10.750; the 10 row here is the 10.000 section). Where
// nominal and true OD differ the aliases carry both spellings ("8 round tube
// 1/4 wall", "8.625 od x .250 wall round tube", "8 5/8 round tube 1/4 wall").
const HSS_ROUND: readonly RoundSize[] = [
  { nominal: 3, od: 3, walls: [3 / 16, 1 / 4] },
  { nominal: 4, od: 4, walls: [1 / 4, 5 / 16] },
  { nominal: 5, od: 5, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { nominal: 6, od: 6, walls: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { nominal: 8, od: 8.625, walls: [1 / 4, 3 / 8, 1 / 2] },
  { nominal: 10, od: 10, walls: [1 / 4, 3 / 8, 1 / 2] },
];

// ASME B36.10 outside diameters and walls. STD is schedule 40 through NPS 10,
// XS is schedule 80 through NPS 8; past those the schedule numbers diverge and
// only the STD/XS form is emitted. XXS where it is stocked.
const PIPE: readonly PipeSize[] = [
  { nps: 0.5, od: 0.84, std: 0.109, xs: 0.147, xxs: null },
  { nps: 0.75, od: 1.05, std: 0.113, xs: 0.154, xxs: null },
  { nps: 1, od: 1.315, std: 0.133, xs: 0.179, xxs: null },
  { nps: 1.25, od: 1.66, std: 0.14, xs: 0.191, xxs: null },
  { nps: 1.5, od: 1.9, std: 0.145, xs: 0.2, xxs: null },
  { nps: 2, od: 2.375, std: 0.154, xs: 0.218, xxs: 0.436 },
  { nps: 2.5, od: 2.875, std: 0.203, xs: 0.276, xxs: 0.552 },
  { nps: 3, od: 3.5, std: 0.216, xs: 0.3, xxs: 0.6 },
  { nps: 3.5, od: 4, std: 0.226, xs: 0.318, xxs: null },
  { nps: 4, od: 4.5, std: 0.237, xs: 0.337, xxs: 0.674 },
  { nps: 5, od: 5.563, std: 0.258, xs: 0.375, xxs: 0.75 },
  { nps: 6, od: 6.625, std: 0.28, xs: 0.432, xxs: 0.864 },
  { nps: 8, od: 8.625, std: 0.322, xs: 0.5, xxs: 0.875 },
  { nps: 10, od: 10.75, std: 0.365, xs: 0.5, xxs: null },
  { nps: 12, od: 12.75, std: 0.375, xs: 0.5, xxs: null },
];

const W_BEAMS: readonly DepthWeight[] = [
  [4, 13],
  [5, 16], [5, 19],
  [6, 9], [6, 12], [6, 15], [6, 16], [6, 20], [6, 25],
  [8, 10], [8, 13], [8, 15], [8, 18], [8, 21], [8, 24], [8, 28], [8, 31], [8, 35], [8, 40],
  [10, 12], [10, 15], [10, 17], [10, 19], [10, 22], [10, 26], [10, 30], [10, 33], [10, 39], [10, 45], [10, 49],
  [12, 14], [12, 16], [12, 19], [12, 22], [12, 26], [12, 30], [12, 35], [12, 40], [12, 45], [12, 50], [12, 53], [12, 58], [12, 65],
  [14, 22], [14, 26], [14, 30], [14, 34], [14, 38], [14, 43], [14, 48], [14, 53], [14, 61], [14, 68],
  [16, 26], [16, 31], [16, 36], [16, 40], [16, 45], [16, 50], [16, 57],
  [18, 35], [18, 40], [18, 46], [18, 50], [18, 55], [18, 60], [18, 65], [18, 71],
  [21, 44], [21, 50], [21, 57], [21, 62], [21, 68],
  [24, 55], [24, 62], [24, 68], [24, 76], [24, 84],
];

const S_BEAMS: readonly DepthWeight[] = [
  [3, 5.7], [3, 7.5],
  [4, 7.7], [4, 9.5],
  [5, 10],
  [6, 12.5], [6, 17.25],
  [8, 18.4], [8, 23],
  [10, 25.4], [10, 35],
  [12, 31.8], [12, 35], [12, 40.8], [12, 50],
  [15, 42.9], [15, 50],
];

const C_CHANNELS: readonly DepthWeight[] = [
  [3, 4.1], [3, 5], [3, 6],
  [4, 5.4], [4, 7.25],
  [5, 6.7], [5, 9],
  [6, 8.2], [6, 10.5], [6, 13],
  [7, 9.8], [7, 12.25],
  [8, 11.5], [8, 13.75], [8, 18.75],
  [9, 13.4], [9, 15], [9, 20],
  [10, 15.3], [10, 20], [10, 25], [10, 30],
  [12, 20.7], [12, 25], [12, 30],
  [15, 33.9], [15, 40], [15, 50],
];

const MC_CHANNELS: readonly DepthWeight[] = [
  [3, 7.1],
  [4, 13.8],
  [6, 12], [6, 15.3], [6, 18],
  [8, 18.7], [8, 20], [8, 22.8],
  [10, 22], [10, 25], [10, 28.5],
  [12, 31], [12, 35], [12, 40], [12, 45], [12, 50],
  [18, 42.7], [18, 45.8], [18, 51.9], [18, 58],
];

// 8x8 angles stop at 3/4 and 1 on purpose: 8x8x1/2 and 8x8x5/8 as bare dims
// must stay HSS (PRD section 14 example and the reply fixtures).
const ANGLES_EQUAL: readonly AngleEqual[] = [
  { leg: 1, thicknesses: [1 / 8, 3 / 16, 1 / 4] },
  { leg: 1.25, thicknesses: [1 / 8, 3 / 16, 1 / 4] },
  { leg: 1.5, thicknesses: [1 / 8, 3 / 16, 1 / 4] },
  { leg: 2, thicknesses: [1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8] },
  { leg: 2.5, thicknesses: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { leg: 3, thicknesses: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { leg: 3.5, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { leg: 4, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 3 / 4] },
  { leg: 5, thicknesses: [5 / 16, 3 / 8, 1 / 2, 3 / 4] },
  { leg: 6, thicknesses: [3 / 8, 1 / 2, 5 / 8, 3 / 4, 1] },
  { leg: 8, thicknesses: [3 / 4, 1] },
];

const ANGLES_UNEQUAL: readonly AngleUnequal[] = [
  { a: 2, b: 1.5, thicknesses: [1 / 8, 3 / 16, 1 / 4] },
  { a: 2.5, b: 1.5, thicknesses: [3 / 16, 1 / 4] },
  { a: 2.5, b: 2, thicknesses: [3 / 16, 1 / 4, 5 / 16, 3 / 8] },
  { a: 3, b: 2, thicknesses: [3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 3, b: 2.5, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 3.5, b: 2.5, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 3.5, b: 3, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 4, b: 3, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8] },
  { a: 4, b: 3.5, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 5, b: 3, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2] },
  { a: 5, b: 3.5, thicknesses: [1 / 4, 5 / 16, 3 / 8, 1 / 2, 3 / 4] },
  { a: 6, b: 3.5, thicknesses: [5 / 16, 3 / 8, 1 / 2] },
  { a: 6, b: 4, thicknesses: [3 / 8, 1 / 2, 5 / 8, 3 / 4] },
  { a: 7, b: 4, thicknesses: [3 / 8, 1 / 2, 3 / 4] },
  { a: 8, b: 4, thicknesses: [1 / 2, 3 / 4, 1] },
  { a: 8, b: 6, thicknesses: [1 / 2, 3 / 4, 1] },
];

// Flat bar: thickness x width, width always wider than the thickness.
const FLAT_BARS: readonly FlatBarRow[] = [
  { t: 1 / 8, widths: [1 / 2, 3 / 4, 1, 1.25, 1.5, 2, 2.5, 3, 4] },
  { t: 3 / 16, widths: [1 / 2, 3 / 4, 1, 1.25, 1.5, 2, 2.5, 3, 4] },
  { t: 1 / 4, widths: [1 / 2, 3 / 4, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8] },
  { t: 5 / 16, widths: [1, 1.25, 1.5, 2, 2.5, 3, 4] },
  { t: 3 / 8, widths: [1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8] },
  { t: 1 / 2, widths: [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8] },
  { t: 5 / 8, widths: [1.5, 2, 2.5, 3, 4, 6] },
  { t: 3 / 4, widths: [2, 2.5, 3, 4, 6, 8] },
  { t: 1, widths: [2, 3, 4, 6, 8] },
];

const ROUND_BARS: readonly number[] = [
  1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8, 1, 1.125, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4,
];

const SQUARE_BARS: readonly number[] = [1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 1, 1.25, 1.5, 2, 2.5, 3];

const PLATES: readonly number[] = [
  3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8, 1, 1.125, 1.25, 1.5, 1.75, 2,
];

// Manufacturers' Standard Gauge for steel sheet (thickness in inches, lb/sqft).
const SHEET_GAUGES: readonly SheetGauge[] = [
  { gauge: 10, t: 0.1345, lbPerSqft: 5.625 },
  { gauge: 11, t: 0.1196, lbPerSqft: 5.0 },
  { gauge: 12, t: 0.1046, lbPerSqft: 4.375 },
  { gauge: 14, t: 0.0747, lbPerSqft: 3.125 },
  { gauge: 16, t: 0.0598, lbPerSqft: 2.5 },
  { gauge: 18, t: 0.0478, lbPerSqft: 2.0 },
  { gauge: 20, t: 0.0359, lbPerSqft: 1.5 },
  { gauge: 22, t: 0.0299, lbPerSqft: 1.25 },
];

// ASTM A615 bar sizes: nominal diameter and published weight per foot.
const REBAR: readonly RebarRow[] = [
  { bar: 3, d: 0.375, lbPerFt: 0.376 },
  { bar: 4, d: 0.5, lbPerFt: 0.668 },
  { bar: 5, d: 0.625, lbPerFt: 1.043 },
  { bar: 6, d: 0.75, lbPerFt: 1.502 },
  { bar: 7, d: 0.875, lbPerFt: 2.044 },
  { bar: 8, d: 1.0, lbPerFt: 2.67 },
  { bar: 9, d: 1.128, lbPerFt: 3.4 },
  { bar: 10, d: 1.27, lbPerFt: 4.303 },
  { bar: 11, d: 1.41, lbPerFt: 5.313 },
];

// Reference grades only (what the shape is usually ordered as). The parser
// never copies these onto a request line; a missing grade stays null + flag.
const GRADE_HSS = "A500 Gr B";
const GRADE_PIPE = "A53 Gr B";
const GRADE_W = "A992";
const GRADE_A36 = "A36";
const GRADE_REBAR = "A615 Gr 60";

// ---------------------------------------------------------------------------
// Weight formulas (lb/ft). Deterministic, tested against AISC within 1 percent.
// ---------------------------------------------------------------------------

const STEEL_LB_PER_IN2_FT = 3.4; // 490 lb/ft3 / 144 in2 per ft2

export function hssRectWeight(b: number, h: number, t: number): number {
  return STEEL_LB_PER_IN2_FT * (2 * t * (b + h) - (16 - 3 * Math.PI) * t * t);
}

export function hssRoundWeight(od: number, t: number): number {
  return STEEL_LB_PER_IN2_FT * Math.PI * t * (od - t);
}

export function pipeWeight(od: number, t: number): number {
  return 10.68 * t * (od - t);
}

export function angleWeight(a: number, b: number, t: number): number {
  return STEEL_LB_PER_IN2_FT * t * (a + b - t);
}

export function flatBarWeight(t: number, w: number): number {
  return STEEL_LB_PER_IN2_FT * t * w;
}

export function roundBarWeight(d: number): number {
  return 2.67 * d * d;
}

export function squareBarWeight(a: number): number {
  return STEEL_LB_PER_IN2_FT * a * a;
}

export function plateWeightPerSqft(t: number): number {
  return 40.8 * t;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Alias helpers
// ---------------------------------------------------------------------------

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

// "1-1/2" plus the spoken "1 1/2" for mixed numbers; one form otherwise.
function fractionForms(n: number): string[] {
  const hyphen = formatFraction(n);
  return hyphen.includes("-") ? [hyphen, hyphen.replace("-", " ")] : [hyphen];
}

// Decimal spellings a shop uses for walls and thicknesses: ".625", "0.625",
// ".250", ".25". Trailing zeros are kept in one form and trimmed in the other.
function decimalForms(n: number): string[] {
  const fixed3 = n.toFixed(3);
  const trimmed = String(Number(n.toFixed(4)));
  return unique([fixed3, trimmed].flatMap((d) => [d, d.replace(/^0\./, ".")]));
}

type ChainStyle = "hyphen" | "space";

// "AxBxT" with every part in the same mixed-number style.
function chain(dims: readonly number[], style: ChainStyle): string {
  return dims
    .map((d) => {
      const f = formatFraction(d);
      return style === "space" ? f.replace("-", " ") : f;
    })
    .join("x");
}

function chains(...dims: number[]): string[] {
  return unique([chain(dims, "hyphen"), chain(dims, "space")]);
}

function item(
  category: MaterialCategory,
  designation: string,
  dims: Record<string, number | string>,
  weightPerFt: number | null,
  defaultGrade: string | null,
  rawAliases: readonly string[],
): CatalogSeedItem {
  const aliases = unique([designation, ...rawAliases].map(normalizeAlias).filter((a) => a !== ""));
  return {
    category,
    designation,
    dims,
    weight_per_ft: weightPerFt === null ? null : round2(weightPerFt),
    default_grade: defaultGrade,
    aliases,
  };
}

// ---------------------------------------------------------------------------
// One function per category
// ---------------------------------------------------------------------------

function angleItems(): CatalogSeedItem[] {
  const items: CatalogSeedItem[] = [];
  const build = (a: number, b: number, t: number): CatalogSeedItem => {
    const designation = `L${chain([a, b, t], "hyphen")}`;
    const raw: string[] = [];
    for (const abt of chains(a, b, t)) {
      raw.push(abt, `l${abt}`, `l ${abt}`, `${abt} angle`, `angle ${abt}`, `${abt} l`, `${abt} angle iron`);
    }
    const tf = formatFraction(t);
    for (const ab of chains(a, b)) {
      raw.push(`${ab} angle ${tf}`, `${ab} ${tf} angle`);
    }
    if (a !== b) {
      // Short leg first is common in shop text; always carries the angle word.
      for (const bat of chains(b, a, t)) {
        raw.push(`l${bat}`, `${bat} angle`, `angle ${bat}`);
      }
    }
    return item("angle", designation, { a, b, t }, angleWeight(a, b, t), GRADE_A36, raw);
  };
  for (const { leg, thicknesses } of ANGLES_EQUAL) {
    for (const t of thicknesses) items.push(build(leg, leg, t));
  }
  for (const { a, b, thicknesses } of ANGLES_UNEQUAL) {
    for (const t of thicknesses) items.push(build(a, b, t));
  }
  return items;
}

// Normalized bare "AxBxT" strings owned by angles; HSS skips these.
function bareDimsOwnedBy(items: readonly CatalogSeedItem[]): Set<string> {
  const owned = new Set<string>();
  for (const it of items) {
    const { a, b, t } = it.dims;
    if (typeof a === "number" && typeof b === "number" && typeof t === "number") {
      for (const abt of chains(a, b, t)) owned.add(normalizeAlias(abt));
    }
  }
  return owned;
}

function hssSquareItems(bareTaken: ReadonlySet<string>): CatalogSeedItem[] {
  const items: CatalogSeedItem[] = [];
  for (const { size, walls } of HSS_SQUARE) {
    for (const t of walls) {
      const designation = `HSS${chain([size, size, t], "hyphen")}`;
      const tf = formatFraction(t);
      const raw: string[] = [];
      for (const aat of chains(size, size, t)) {
        raw.push(
          `hss${aat}`,
          `hss ${aat}`,
          `${aat} tube`,
          `${aat} hss`,
          `${aat} square tube`,
          `${aat} sq tube`,
          `${aat} wall`,
        );
        if (!bareTaken.has(normalizeAlias(aat))) raw.push(aat);
      }
      for (const aa of chains(size, size)) {
        raw.push(
          `${aa} ${tf} wall`,
          `${aa} tube ${tf} wall`,
          `${aa} square tube ${tf} wall`,
        );
        for (const d of decimalForms(t)) {
          raw.push(`${aa}x${d}`, `${aa}x${d} tube`, `${aa}x${d} wall`, `hss${aa}x${d}`, `${aa} ${d} wall`);
        }
      }
      for (const af of fractionForms(size)) {
        raw.push(
          `${af} square ${tf}`,
          `${af} sq ${tf}`,
          `${af}" sq tube ${tf}`,
          `${af} square tube ${tf}`,
          `${af} square ${tf} wall`,
          `${af} sq ${tf} wall`,
          `${af} sq tube ${tf} wall`,
          `${af} square tube ${tf} wall`,
        );
        for (const d of decimalForms(t)) {
          raw.push(`${af} sq tube ${d} wall`, `${af} square ${d} wall`);
        }
      }
      items.push(item("hss_square", designation, { a: size, b: size, t }, hssRectWeight(size, size, t), GRADE_HSS, raw));
    }
  }
  return items;
}

function hssRectItems(bareTaken: ReadonlySet<string>): CatalogSeedItem[] {
  const items: CatalogSeedItem[] = [];
  for (const { a, b, walls } of HSS_RECT) {
    for (const t of walls) {
      const designation = `HSS${chain([a, b, t], "hyphen")}`;
      const tf = formatFraction(t);
      const raw: string[] = [];
      for (const abt of chains(a, b, t)) {
        raw.push(
          `hss${abt}`,
          `hss ${abt}`,
          `${abt} tube`,
          `${abt} hss`,
          `${abt} rect tube`,
          `${abt} rectangular tube`,
          `${abt} wall`,
        );
        if (!bareTaken.has(normalizeAlias(abt))) raw.push(abt);
      }
      // Short side first also shows up in shop text; always with a tube word.
      for (const bat of chains(b, a, t)) {
        raw.push(`hss${bat}`, `${bat} tube`, `${bat} hss`, `${bat} rect tube`);
      }
      for (const ab of chains(a, b)) {
        raw.push(`${ab} ${tf} wall`, `${ab} tube ${tf} wall`, `${ab} rect tube ${tf} wall`, `${ab} rectangular tube ${tf} wall`);
        for (const d of decimalForms(t)) {
          raw.push(`${ab}x${d}`, `${ab}x${d} tube`, `${ab}x${d} wall`, `hss${ab}x${d}`, `${ab} ${d} wall`);
        }
      }
      for (const ba of chains(b, a)) {
        raw.push(`${ba} ${tf} wall`, `${ba} tube ${tf} wall`);
      }
      items.push(item("hss_rectangular", designation, { a, b, t }, hssRectWeight(a, b, t), GRADE_HSS, raw));
    }
  }
  return items;
}

function hssRoundItems(): CatalogSeedItem[] {
  const items: CatalogSeedItem[] = [];
  for (const { nominal, od, walls } of HSS_ROUND) {
    for (const t of walls) {
      const tf = formatFraction(t);
      const designation = `HSS${nominal}x${tf}`;
      const raw: string[] = [
        `hss ${nominal}x${tf}`,
        `${nominal}x${tf} round tube`,
        `${nominal}x${tf} rd tube`,
        `${nominal}x${tf} round hss`,
        `${nominal}x${tf} tube`,
        `${nominal} round tube ${tf}`,
        `${nominal} round tube ${tf} wall`,
        `${nominal} round ${tf} wall`,
        `${nominal} rd ${tf} wall`,
        `${nominal} od round tube ${tf} wall`,
        `${nominal} od x ${tf} round tube`,
        `${nominal} od x ${tf} wall tube`,
        `${nominal} od tube ${tf} wall`,
        `round tube ${nominal}x${tf}`,
      ];
      for (const d of decimalForms(t)) {
        raw.push(
          `${nominal}x${d} round tube`,
          `${nominal}x${d} tube`,
          `hss${nominal}x${d}`,
          `${nominal} od x ${d} wall round tube`,
          `${nominal} round tube ${d} wall`,
        );
      }
      if (od !== nominal) {
        // The true OD as a decimal ("8.625") and as a mixed number ("8-5/8",
        // "8 5/8"), always with a tube word so pipe aliases stay apart.
        raw.push(
          `hss ${od}x${tf}`,
          `${od}x${tf} round tube`,
          `${od}x${tf} tube`,
          `${od} round tube ${tf} wall`,
          `${od} od round tube ${tf} wall`,
          `${od} od x ${tf} round tube`,
          `${od} od x ${tf} wall tube`,
          `round tube ${od}x${tf}`,
        );
        for (const d of decimalForms(t)) {
          raw.push(`${od}x${d} round tube`, `${od}x${d} tube`, `hss${od}x${d}`, `${od} od x ${d} wall round tube`, `${od} round tube ${d} wall`);
        }
        for (const f of fractionForms(od)) {
          raw.push(`${f} round tube ${tf} wall`, `${f} round tube ${tf}`, `${f} od round tube ${tf} wall`, `${f} rd ${tf} wall`, `${f} od x ${tf} round tube`);
        }
      }
      items.push(item("hss_round", designation, { od, nominal, t }, hssRoundWeight(od, t), GRADE_HSS, raw));
    }
  }
  return items;
}

type PipeClass = "STD" | "XS" | "XXS";

function pipeItems(): CatalogSeedItem[] {
  const items: CatalogSeedItem[] = [];
  for (const row of PIPE) {
    const classes: Array<[PipeClass, number | null]> = [
      ["STD", row.std],
      ["XS", row.xs],
      ["XXS", row.xxs],
    ];
    for (const [cls, wall] of classes) {
      if (wall === null) continue;
      const nf = formatFraction(row.nps);
      const designation = `PIPE${nf}${cls}`;
      const sch = cls === "STD" && row.nps <= 10 ? 40 : cls === "XS" && row.nps <= 8 ? 80 : null;
      const words = pipeClassWords(cls);
      const raw: string[] = [];
      for (const n of fractionForms(row.nps)) {
        for (const w of words) {
          raw.push(`${n} pipe ${w}`, `${n} ${w} pipe`, `pipe ${n} ${w}`, `${n}" ${w} pipe`);
        }
        if (sch !== null) {
          raw.push(
            `${n} sch ${sch} pipe`,
            `${n} pipe sch ${sch}`,
            `${n} sch ${sch}`,
            `pipe ${n} sch ${sch}`,
            `${n}" sch ${sch} pipe`,
            `${n} inch pipe sch ${sch}`,
            `${n} schedule ${sch} pipe`,
            `${n} sch${sch} pipe`,
          );
        }
        for (const d of decimalForms(wall)) {
          raw.push(`${n}x${d} pipe`, `${n} pipe x ${d} wall`, `${n} pipe ${d} wall`);
        }
      }
      for (const d of decimalForms(wall)) {
        raw.push(`${row.od}x${d} pipe`, `${row.od} od x ${d} wall pipe`);
      }
      const dims: Record<string, number | string> = { nps: row.nps, od: row.od, t: wall, schedule: cls };
      if (sch !== null) dims.sch = sch;
      items.push(item("pipe", designation, dims, pipeWeight(row.od, wall), GRADE_PIPE, raw));
    }
  }
  return items;
}

function pipeClassWords(cls: PipeClass): string[] {
  switch (cls) {
    case "STD":
      return ["std", "standard", "standard weight", "std wt"];
    case "XS":
      return ["xs", "xh", "extra strong", "extra heavy"];
    case "XXS":
      return ["xxs", "xxh", "double extra strong", "double extra heavy"];
  }
}

function wBeamItems(): CatalogSeedItem[] {
  return W_BEAMS.map(([d, wt]) =>
    item(
      "w_beam",
      `W${d}x${wt}`,
      { d, wt },
      wt,
      GRADE_W,
      [
        `w ${d}x${wt}`,
        `${d}x${wt} beam`,
        `${d}x${wt} wf`,
        `${d}x${wt} w`,
        `${d}x${wt} wide flange`,
        `${d}x${wt} wide flange beam`,
        `${d} wf ${wt}`,
        `${d} wf ${wt}#`,
        `${d}" wf ${wt} lb`,
        `${d} wide flange ${wt}`,
        `${d} beam ${wt} lb`,
        `w${d}x${wt} beam`,
        `wf ${d}x${wt}`,
        `beam ${d}x${wt}`,
        // "#" glued to the weight in the designation shape ("W12x26#"). Always
        // with the W prefix or a beam word: a bare "12x30#" would be C12x30 too.
        `w${d}x${wt}#`,
        `w ${d}x${wt}#`,
        `w${d}x${wt}# beam`,
        `${d}x${wt}# wf`,
        `${d}x${wt}# wide flange`,
      ],
    ),
  );
}

function sBeamItems(): CatalogSeedItem[] {
  return S_BEAMS.map(([d, wt]) =>
    item(
      "s_beam",
      `S${d}x${wt}`,
      { d, wt },
      wt,
      GRADE_A36,
      [
        `s ${d}x${wt}`,
        `${d}x${wt} s beam`,
        `${d}x${wt} i beam`,
        `${d}x${wt} standard beam`,
        `${d}x${wt} s`,
        `${d} i beam ${wt}`,
        `${d} i beam ${wt}#`,
        `${d} s beam ${wt}`,
        `s${d}x${wt} beam`,
        `i beam ${d}x${wt}`,
        `s${d}x${wt}#`,
        `s ${d}x${wt}#`,
        `${d}x${wt}# s beam`,
        `${d}x${wt}# i beam`,
      ],
    ),
  );
}

function channelItems(): CatalogSeedItem[] {
  const c = C_CHANNELS.map(([d, wt]) =>
    item(
      "channel",
      `C${d}x${wt}`,
      { d, wt, series: "C" },
      wt,
      GRADE_A36,
      [
        `c ${d}x${wt}`,
        `${d}x${wt} channel`,
        `${d}x${wt} c`,
        `${d}x${wt} c channel`,
        `${d} x ${wt} channel`,
        `channel ${d}x${wt}`,
        `${d} channel ${wt}`,
        `${d} channel ${wt}#`,
        `${d} channel ${wt} lb`,
        `${d}" channel ${wt} lb`,
        `${d} inch channel ${wt}#`,
        `${d} ch ${wt}`,
        `${d} ch ${wt}#`,
        `${d}x${wt} ch`,
        `c${d}x${wt} channel`,
        // "#" glued to the weight in the designation shape ("C12x30#"). Always
        // with the C prefix or a channel word: a bare "12x30#" would be W12x30 too.
        `c${d}x${wt}#`,
        `c ${d}x${wt}#`,
        `c${d}x${wt}# channel`,
        `${d}x${wt}# channel`,
      ],
    ),
  );
  // MC shares depth and weight numbers with some C sizes (MC10x25 and C10x25),
  // so every MC alias carries "mc".
  const mc = MC_CHANNELS.map(([d, wt]) =>
    item(
      "channel",
      `MC${d}x${wt}`,
      { d, wt, series: "MC" },
      wt,
      GRADE_A36,
      [
        `mc ${d}x${wt}`,
        `${d}x${wt} mc`,
        `${d}x${wt} mc channel`,
        `mc channel ${d}x${wt}`,
        `${d} mc ${wt}`,
        `${d} mc ${wt}#`,
        `${d} mc ${wt} lb`,
        `${d} mc channel ${wt} lb`,
        `mc${d}x${wt} channel`,
        `${d}x${wt} miscellaneous channel`,
        `mc${d}x${wt}#`,
        `mc ${d}x${wt}#`,
        `mc${d}x${wt}# channel`,
        `${d}x${wt}# mc`,
        `${d}x${wt}# mc channel`,
      ],
    ),
  );
  return [...c, ...mc];
}

function flatBarItems(): CatalogSeedItem[] {
  const items: CatalogSeedItem[] = [];
  for (const { t, widths } of FLAT_BARS) {
    for (const w of widths) {
      const designation = `FB${chain([t, w], "hyphen")}`;
      const raw: string[] = [];
      for (const tw of chains(t, w)) {
        raw.push(`fb${tw}`, `fb ${tw}`, `${tw} flat bar`, `${tw} flat`, `${tw} fb`, `${tw} flat stock`, `flat bar ${tw}`);
      }
      // Width first is just as common ("2 x 1/4 flat").
      for (const wt of chains(w, t)) {
        raw.push(`fb${wt}`, `fb ${wt}`, `${wt} flat bar`, `${wt} flat`, `${wt} fb`, `flat bar ${wt}`);
      }
      items.push(item("flat_bar", designation, { t, w }, flatBarWeight(t, w), GRADE_A36, raw));
    }
  }
  return items;
}

function roundBarItems(): CatalogSeedItem[] {
  return ROUND_BARS.map((d) => {
    const designation = `RB${formatFraction(d)}`;
    const raw: string[] = [];
    for (const df of fractionForms(d)) {
      raw.push(
        `rb${df}`,
        `rb ${df}`,
        `${df} round bar`,
        `${df} rd bar`,
        `${df} round`,
        `${df} rd`,
        `${df} rnd bar`,
        `${df}" round bar`,
        `${df} dia round bar`,
        `${df} dia round`,
        `${df} dia rd`,
        `${df} round stock`,
        `${df} round rod`,
        `round bar ${df}`,
      );
    }
    for (const dec of decimalForms(d)) {
      raw.push(`${dec} round bar`, `${dec} rd`, `${dec} dia round bar`);
    }
    return item("round_bar", designation, { d }, roundBarWeight(d), GRADE_A36, raw);
  });
}

function squareBarItems(): CatalogSeedItem[] {
  return SQUARE_BARS.map((a) => {
    const designation = `SQ${formatFraction(a)}`;
    const raw: string[] = [];
    for (const af of fractionForms(a)) {
      raw.push(
        `sq${af}`,
        `sq ${af} bar`,
        `${af} sq bar`,
        `${af} square bar`,
        `${af}x${af} sq bar`,
        `${af}x${af} square bar`,
        `${af} square stock`,
        `${af} sq stock`,
        `${af}" square bar`,
        `square bar ${af}`,
      );
    }
    for (const dec of decimalForms(a)) {
      raw.push(`${dec} square bar`, `${dec} sq bar`);
    }
    return item("square_bar", designation, { a }, squareBarWeight(a), GRADE_A36, raw);
  });
}

function plateItems(): CatalogSeedItem[] {
  return PLATES.map((t) => {
    const designation = `PL${formatFraction(t)}`;
    const raw: string[] = [];
    for (const tf of fractionForms(t)) {
      raw.push(
        `pl${tf}`,
        `pl ${tf}`,
        `${tf} plate`,
        `plate ${tf}`,
        `${tf} pl`,
        `${tf} plt`,
        `${tf}" plate`,
        `${tf} thick plate`,
        `${tf} steel plate`,
        `${tf} thk plate`,
        `${tf} plate steel`,
      );
    }
    for (const dec of decimalForms(t)) {
      raw.push(`${dec} plate`, `plate ${dec}`, `pl ${dec}`, `${dec} thick plate`, `${dec} pl`);
    }
    return item("plate", designation, { t, weight_per_sqft: round2(plateWeightPerSqft(t)) }, null, GRADE_A36, raw);
  });
}

function sheetItems(): CatalogSeedItem[] {
  return SHEET_GAUGES.map(({ gauge, t, lbPerSqft }) =>
    item(
      "sheet",
      `SH${gauge}GA`,
      { gauge, t, weight_per_sqft: lbPerSqft },
      null,
      null,
      [
        `${gauge} ga sheet`,
        `${gauge} gauge sheet`,
        `${gauge} gage sheet`,
        `${gauge}ga sheet`,
        `${gauge} ga`,
        `${gauge} gauge`,
        `${gauge}ga`,
        `sheet ${gauge} ga`,
        `sheet ${gauge} gauge`,
        `${gauge} ga sheet metal`,
        `${gauge} ga steel sheet`,
        `${gauge} ga sheet steel`,
        `sh ${gauge} ga`,
      ],
    ),
  );
}

function rebarItems(): CatalogSeedItem[] {
  return REBAR.map(({ bar, d, lbPerFt }) => {
    const raw: string[] = [
      `#${bar} rebar`,
      `${bar} rebar`,
      `no ${bar} rebar`,
      `no. ${bar} rebar`,
      `number ${bar} rebar`,
      `#${bar} reinforcing bar`,
      `#${bar} rebar bar`,
      `rebar #${bar}`,
      `rebar no ${bar}`,
      `#${bar} deformed bar`,
    ];
    const df = formatFraction(d);
    // Only the bar sizes whose diameter is an exact sixteenth get a diameter alias.
    if (!df.includes(".")) raw.push(`${df} rebar`, `${df}" rebar`, `${df} dia rebar`);
    return item("rebar", `REBAR#${bar}`, { bar_number: bar, d }, lbPerFt, GRADE_REBAR, raw);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The whole seed catalog. Designations are unique, every alias is already
 * normalized and deduped within its item, and no normalized alias appears on
 * two items (generate.test.ts asserts all three).
 */
export function generateCatalog(): CatalogSeedItem[] {
  const angles = angleItems();
  const bareTaken = bareDimsOwnedBy(angles);
  return [
    ...hssSquareItems(bareTaken),
    ...hssRectItems(bareTaken),
    ...hssRoundItems(),
    ...pipeItems(),
    ...wBeamItems(),
    ...sBeamItems(),
    ...channelItems(),
    ...angles,
    ...flatBarItems(),
    ...roundBarItems(),
    ...squareBarItems(),
    ...plateItems(),
    ...sheetItems(),
    ...rebarItems(),
  ];
}

/** Normalized alias -> item. The first item to claim an alias keeps it. */
export function buildAliasIndex(items: readonly CatalogSeedItem[]): Map<string, CatalogSeedItem> {
  const index = new Map<string, CatalogSeedItem>();
  for (const it of items) {
    for (const alias of it.aliases) {
      if (!index.has(alias)) index.set(alias, it);
    }
  }
  return index;
}

/** Aliases that appear on more than one item, with the designations involved. */
export function findAliasCollisions(
  items: readonly CatalogSeedItem[],
): Array<{ alias: string; designations: string[] }> {
  const owners = new Map<string, string[]>();
  for (const it of items) {
    for (const alias of it.aliases) {
      const list = owners.get(alias);
      if (list) list.push(it.designation);
      else owners.set(alias, [it.designation]);
    }
  }
  const collisions: Array<{ alias: string; designations: string[] }> = [];
  for (const [alias, designations] of owners) {
    if (designations.length > 1) collisions.push({ alias, designations });
  }
  return collisions;
}

const indexCache = new WeakMap<readonly CatalogSeedItem[], Map<string, CatalogSeedItem>>();

/**
 * Exact alias lookup: normalizes the text and returns the item that owns that
 * alias, or null. This is the in-memory twin of the database lookup the parser
 * uses in its deterministic pass.
 */
export function findItemByAlias(items: readonly CatalogSeedItem[], text: string): CatalogSeedItem | null {
  const key = normalizeAlias(text);
  if (key === "") return null;
  let index = indexCache.get(items);
  if (!index) {
    index = buildAliasIndex(items);
    indexCache.set(items, index);
  }
  return index.get(key) ?? null;
}
