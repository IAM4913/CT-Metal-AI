// In-memory alias index for the deterministic pass.
//
// The parser looks items up by two kinds of key: a normalized alias
// (normalizeAlias, the same function that normalized every stored alias) and a
// designation key (the designation uppercased with spaces removed, so "HSS 8x8x5/8"
// and "hss8x8x5/8" both reach HSS8x8x5/8 even when no alias row says so).
//
// createAliasIndex() takes catalog_aliases rows joined to their items, as the
// server loads them (seed rows plus this broker's learned rows). The first row
// to claim a key keeps it, so callers that want learned aliases to win pass
// them first. aliasIndexFromCatalog() builds the same index from the seed
// generator for tests, using the designation as the item id.
//
// Not to be confused with buildAliasIndex() in src/lib/catalog/generate.ts,
// which maps aliases to seed items for the generator's own tests.

import type { CatalogSeedItem } from "@/lib/catalog/generate";
import { normalizeAlias } from "@/lib/catalog/normalize";
import type { MaterialCategory } from "@/lib/db/enums";

export type AliasIndexEntry = {
  catalog_item_id: string;
  designation: string;
  category: MaterialCategory;
  weight_per_ft: number | null;
  dims: Record<string, unknown>;
};

export type AliasIndex = {
  byAlias: Map<string, AliasIndexEntry>;
  byDesignation: Map<string, AliasIndexEntry>;
};

export type AliasIndexRow = {
  alias: string;
  catalog_item_id: string;
  designation: string;
  category: MaterialCategory;
  weight_per_ft: number | null;
  dims: Record<string, unknown>;
};

/** "HSS 8x8x5/8" -> "HSS8X8X5/8": the designation map key. */
export function designationKey(text: string): string {
  return text.replace(/\s+/g, "").toUpperCase();
}

export function createAliasIndex(rows: AliasIndexRow[]): AliasIndex {
  const byAlias = new Map<string, AliasIndexEntry>();
  const byDesignation = new Map<string, AliasIndexEntry>();
  for (const row of rows) {
    const entry: AliasIndexEntry = {
      catalog_item_id: row.catalog_item_id,
      designation: row.designation,
      category: row.category,
      weight_per_ft: row.weight_per_ft,
      dims: row.dims,
    };
    const aliasKey = normalizeAlias(row.alias);
    if (aliasKey !== "" && !byAlias.has(aliasKey)) byAlias.set(aliasKey, entry);
    const desigKey = designationKey(row.designation);
    if (desigKey !== "" && !byDesignation.has(desigKey)) byDesignation.set(desigKey, entry);
  }
  return { byAlias, byDesignation };
}

/** The seed catalog as an index. catalog_item_id is the designation (tests have no database ids). */
export function aliasIndexFromCatalog(items: CatalogSeedItem[]): AliasIndex {
  const rows: AliasIndexRow[] = [];
  for (const item of items) {
    const aliases = item.aliases.length > 0 ? item.aliases : [item.designation];
    for (const alias of aliases) {
      rows.push({
        alias,
        catalog_item_id: item.designation,
        designation: item.designation,
        category: item.category,
        weight_per_ft: item.weight_per_ft,
        dims: item.dims,
      });
    }
  }
  return createAliasIndex(rows);
}

/**
 * Try each candidate in order: first as a normalized alias, then as a
 * designation key. Blank candidates are skipped. Null when nothing matches.
 */
export function lookupItem(index: AliasIndex, candidates: string[]): AliasIndexEntry | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const aliasKey = normalizeAlias(candidate);
    if (aliasKey !== "") {
      const byAlias = index.byAlias.get(aliasKey);
      if (byAlias) return byAlias;
    }
    const byDesignation = index.byDesignation.get(designationKey(candidate));
    if (byDesignation) return byDesignation;
  }
  return null;
}
