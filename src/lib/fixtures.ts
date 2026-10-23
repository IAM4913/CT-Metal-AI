// Paths and readers for the committed test fixtures under fixtures/ (PRD section 15).
//
// Node-only (fs and path). Imported by Vitest tests and by scripts/, never by
// app code. Fixture files are the source of truth for the parser tests, so the
// names here are the names on disk; add a file and its name in the same change.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Request fixtures that intake can ingest directly (PRD section 15, Requests 1 to 5). */
export const REQUEST_FIXTURES = [
  "single-hss.txt",
  "channel-heavier.txt",
  "mixed-list.eml",
  "ambiguous.txt",
  "pdf-list.eml",
] as const;

/** Reply fixtures that offer ingestion can ingest directly (PRD section 15, Replies 1 to 5). */
export const REPLY_FIXTURES = [
  "alt-wall-rolling.txt",
  "partial-discount.txt",
  "future-rolling.txt",
  "quote.pdf.eml",
  "decline.txt",
] as const;

/**
 * The PDF attachments carried inside pdf-list.eml and quote.pdf.eml, also
 * committed standalone so a test or a demo can upload the PDF on its own.
 * scripts/make-fixture-pdfs.ts writes both the .pdf and the .eml from the
 * same bytes, so the pairs always agree.
 */
export const FIXTURE_ATTACHMENTS = ["requests/pdf-list.pdf", "replies/quote.pdf"] as const;

export type RequestFixtureName = (typeof REQUEST_FIXTURES)[number];
export type ReplyFixtureName = (typeof REPLY_FIXTURES)[number];

/**
 * Absolute path of the fixtures/ directory. Walks up from the working directory
 * until it finds a package.json with a fixtures/ folder beside it, so the same
 * code works from `npm test`, `tsx scripts/...`, and a nested cwd. Throws when
 * no repo root is found rather than guessing a path.
 */
export function fixtureRoot(): string {
  let dir = path.resolve(process.cwd());
  for (;;) {
    const candidate = path.join(dir, "fixtures");
    if (existsSync(path.join(dir, "package.json")) && isDirectory(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the fixtures directory walking up from ${process.cwd()}. Run from inside the repo.`,
      );
    }
    dir = parent;
  }
}

/** Absolute path of a request fixture, for example requestFixturePath("mixed-list.eml"). */
export function requestFixturePath(name: RequestFixtureName | string): string {
  return path.join(fixtureRoot(), "requests", name);
}

/** Absolute path of a reply fixture, for example replyFixturePath("quote.pdf.eml"). */
export function replyFixturePath(name: ReplyFixtureName | string): string {
  return path.join(fixtureRoot(), "replies", name);
}

/**
 * Read a fixture by its path relative to fixtures/, for example
 * readFixture("requests/mixed-list.eml"). Returns the raw bytes; callers decode.
 * Refuses paths that resolve outside fixtures/.
 */
export function readFixture(relPath: string): Buffer {
  const root = fixtureRoot();
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Fixture path escapes the fixtures directory: ${relPath}`);
  }
  return readFileSync(resolved);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
