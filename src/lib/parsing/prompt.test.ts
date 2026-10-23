import { describe, expect, it } from "vitest";
import { materialCategoryValues } from "@/lib/db/enums";
import { buildExtractionDocument } from "./document";
import { BEGIN_DOCUMENT, buildExtractionUserMessage, END_DOCUMENT, EXTRACTION_SYSTEM_PROMPT } from "./prompt";

const EM_DASH = String.fromCharCode(0x2014);

describe("EXTRACTION_SYSTEM_PROMPT", () => {
  it("opens with the PRD section 13 stance", () => {
    expect(EXTRACTION_SYSTEM_PROMPT.startsWith("You are extracting line items from steel material requests sent to a broker in Texas.")).toBe(
      true,
    );
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"8 square 5/8" means HSS 8x8 with 5/8 wall');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"12 inch channel 30#" means C12x30');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"#" and "lb" after a number denote weight per foot');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Do not guess grades. Do not guess quantities.");
  });

  it("tells the model never to fill a grade, quantity, or length and to copy raw_text verbatim", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Never guess a grade, quantity, or length. Missing means null.");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("raw_text must be copied verbatim from the document and span must be its character offsets");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Fractions and mixed numbers stay strings exactly as written");
  });

  it("carries the fixture shop-language examples and the exclusions", () => {
    for (const needle of [
      '"6" sq 3/8 x 24\'"',
      '"3/8 plate 48x96 qty 10 A36"',
      "t 3/8, w 48, l 96",
      '"or heavier"',
      "if 3/8 is too heavy can look at 1/2",
      '"some angle for clips"',
      'start with ">"',
      '"wrote:"',
      "Signature blocks",
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT, needle).toContain(needle);
    }
  });

  it("lists every material category and the dims keys per category", () => {
    for (const category of materialCategoryValues) expect(EXTRACTION_SYSTEM_PROMPT).toContain(category);
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("hss_square and hss_rectangular: a, b, t");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("channel: d, wt, series");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("pipe: nps");
  });

  it("has no em dash", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain(EM_DASH);
  });
});

describe("buildExtractionUserMessage", () => {
  const doc = buildExtractionDocument([
    { kind: "text", text: "12 inch channel 30# or heavier, 6 pcs at 40 ft" },
    { kind: "attachment", attachmentId: "att-1", filename: "list.pdf", page: 1, text: "HSS4x4x1/4 30 pcs 24'" },
  ]);
  const message = buildExtractionUserMessage(doc);

  it("wraps the document text unchanged between the markers", () => {
    expect(message).toContain(`${BEGIN_DOCUMENT}\n${doc.text}\n${END_DOCUMENT}`);
    expect(message.endsWith(END_DOCUMENT)).toBe(true);
  });

  it("states the character count and the layout", () => {
    expect(message).toContain(`It is ${doc.text.length} characters long.`);
    expect(message).toContain("1 attachment page");
    expect(message).toContain("=== SOURCE TEXT ===");
  });

  it("has no em dash", () => {
    expect(message).not.toContain(EM_DASH);
    expect(buildExtractionUserMessage(buildExtractionDocument([{ kind: "text", text: "3/8 plate" }]))).not.toContain(EM_DASH);
  });
});
