import { describe, expect, it } from "vitest";
import { readFixture } from "@/lib/fixtures";
import { extractPdfPages } from "./pdf-text";

describe("extractPdfPages", () => {
  it("yields one page of text for fixtures/requests/pdf-list.pdf with the table rows", async () => {
    const pages = await extractPdfPages(readFixture("requests/pdf-list.pdf"));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("HSS4x4x1/4");
    expect(pages[0]).toContain("PIPE2STD");
    expect(pages[0]).toContain("W8x18");
    expect(pages[0]).toContain("Brazos Valley Fabricators");
  });

  it("leaves the caller's bytes untouched", async () => {
    const bytes = readFixture("requests/pdf-list.pdf");
    const copy = Buffer.from(bytes);
    await extractPdfPages(bytes);
    expect(bytes.byteLength).toBe(copy.byteLength);
    expect(bytes.equals(copy)).toBe(true);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(extractPdfPages(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });
});
