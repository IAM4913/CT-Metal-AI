// PDF text for parsing: one string per page, through pdf-parse 2.x.
//
// The page split matters because request_lines.source_span for an attachment
// records attachment id, page, and offsets into that page's text (PRD section
// 7), so the extraction document is built one segment per page.
//
// The bytes are copied before pdf.js sees them: pdf.js may take ownership of
// the buffer it is given, and the caller's bytes (an attachment just
// downloaded, a fixture in a test) must stay usable afterwards.

import { PDFParse } from "pdf-parse";

/** Text of every page in order (index 0 is page 1). An empty document yields []. */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    return [...result.pages].sort((a, b) => a.num - b.num).map((page) => page.text);
  } finally {
    await parser.destroy();
  }
}
