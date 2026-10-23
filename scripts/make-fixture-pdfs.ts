// Generate the two PDF fixtures from PRD section 15 and the .eml files that carry
// them as attachments, so the .pdf and the .eml always hold the same bytes.
//
//   npm run make-fixture-pdfs
//
// Writes:
//   fixtures/requests/pdf-list.pdf      one-page material list from Brazos Valley Fabricators
//   fixtures/requests/pdf-list.eml      Rita's email with pdf-list.pdf attached as bryan-shop-list.pdf
//   fixtures/replies/quote.pdf          one-page vendor quote from Delta Steel Houston
//   fixtures/replies/quote.pdf.eml      Marcus's reply with quote.pdf attached as delta-quote-4417.pdf
//
// pdfkit is a dev dependency used only here; src/ never imports it (reply
// ingestion reads PDFs with pdf-parse). Output is deterministic: the info
// dictionary dates are fixed, pdfkit derives the file /ID from the info
// dictionary, standard fonts are referenced rather than embedded, and nothing
// random is drawn. Running the script twice yields byte-identical files.

import { writeFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import { requestFixturePath, replyFixturePath } from "../src/lib/fixtures";

type Doc = InstanceType<typeof PDFDocument>;

// Fixed timestamps so the PDF info dictionary, XMP metadata, and /ID never change.
const REQUEST_PDF_DATE = new Date("2026-10-20T19:05:00Z");
const QUOTE_PDF_DATE = new Date("2026-10-22T16:17:00Z");

// Email header dates (US Central, matching the people in the fixtures).
const REQUEST_EMAIL_DATE = "Tue, 20 Oct 2026 14:05:00 -0500";
const QUOTE_EMAIL_DATE = "Thu, 22 Oct 2026 11:17:00 -0500";

const BROKER_EMAIL = "caleb@example.com";
const RFQ_MESSAGE_ID = "<anvil-rfq-00000000-0000-4000-8000-000000000000@noop.anvil.local>";

// ---------------------------------------------------------------------------
// Table content (the shared contract for this step; tests assert on these values)
// ---------------------------------------------------------------------------

const REQUEST_TABLE = {
  header: ["Item", "Description", "Qty", "Length", "Grade"],
  widths: [13, 24, 9, 9, 10],
  rows: [
    ["HSS4x4x1/4", "4x4x1/4 square tube", "30 pcs", "24'", "A500 Gr B"],
    ["W8x18", "wide flange", "6 pcs", "40'", "A992"],
    ["L3x3x1/4", "angle", "24 pcs", "20'", "A36"],
    ["PL1/2", "plate 60 x 120", "4 pcs", "", "A36"],
    ["PIPE2STD", "2\" sch 40 pipe", "12 pcs", "21'", "A53 Gr B"],
  ],
};

const QUOTE_TABLE = {
  header: ["Item", "Qty", "Price", "Basis", "Availability"],
  widths: [22, 9, 10, 8, 14],
  rows: [
    ["W12x26 x 50'", "8 pcs", "$62.50", "cwt", "stock"],
    ["L2x2x1/4 x 20'", "40 pcs", "$0.98", "ft", "stock"],
    ["PL3/8 48x96 A36", "10 pcs", "$58.00", "cwt", "stock"],
    ["HSS6x6x3/8 x 24'", "20 pcs", "$71.00", "cwt", "rolling 11/17"],
  ],
};

const QUOTE_FOOTER = [
  "Terms: Net 30, 1% 10 days",
  "Freight included to Fort Worth",
  "Quote valid 7 days",
];

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

type PdfInfo = {
  Title: string;
  Author: string;
  Subject: string;
  date: Date;
};

function renderPdf(info: PdfInfo, draw: (doc: Doc) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 54,
      info: {
        Title: info.Title,
        Author: info.Author,
        Subject: info.Subject,
        Creator: "Anvil fixture generator",
        Producer: "Anvil fixture generator (pdfkit)",
        CreationDate: info.date,
        ModDate: info.date,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    draw(doc);
    doc.end();
  });
}

/** Pad each cell to its column width so the row reads as one monospaced line. */
function tableLine(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i])))
    .join("")
    .trimEnd();
}

function drawTable(
  doc: Doc,
  table: { header: string[]; widths: number[]; rows: string[][] },
): void {
  doc.font("Courier-Bold").fontSize(10).text(tableLine(table.header, table.widths));
  doc.font("Courier").text("-".repeat(table.widths.reduce((a, b) => a + b, 0)));
  for (const row of table.rows) {
    doc.text(tableLine(row, table.widths));
  }
}

function drawRequestPdf(doc: Doc): void {
  doc.font("Helvetica-Bold").fontSize(16).text("Brazos Valley Fabricators");
  doc.font("Helvetica").fontSize(12).text("Material list: Bryan shop expansion");
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text("From: Rita Alvarez, Brazos Valley Fabricators (rita@brazosfab.example.com)");
  doc.text(`To: Caleb (${BROKER_EMAIL})`);
  doc.text("Date: October 20, 2026");
  doc.moveDown();
  drawTable(doc, REQUEST_TABLE);
  doc.moveDown();
  doc.font("Helvetica").fontSize(10).text("Need everything on site by Nov 10. Deliver to the Bryan shop.");
}

function drawQuotePdf(doc: Doc): void {
  doc.font("Helvetica-Bold").fontSize(16).text("Delta Steel, Houston");
  doc.font("Helvetica").fontSize(12).text("Quotation 4417");
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text("From: Marcus Reed, Delta Steel Houston (marcus.reed@example.com)");
  doc.text(`To: Caleb (${BROKER_EMAIL})`);
  doc.text("Re: RFQ: Lone Star, 4 items");
  doc.text("Date: October 22, 2026");
  doc.moveDown();
  drawTable(doc, QUOTE_TABLE);
  doc.moveDown();
  doc.font("Helvetica").fontSize(10);
  for (const line of QUOTE_FOOTER) {
    doc.text(line);
  }
}

// ---------------------------------------------------------------------------
// .eml assembly (RFC 5322, CRLF line endings, base64 wrapped at 76 characters)
// ---------------------------------------------------------------------------

type EmlSpec = {
  headers: [string, string][];
  boundary: string;
  bodyText: string;
  attachment: { filename: string; bytes: Buffer };
};

function base64Lines(bytes: Buffer): string[] {
  const b64 = bytes.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines;
}

function buildEml(spec: EmlSpec): Buffer {
  const lines: string[] = [];
  for (const [name, value] of spec.headers) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/mixed; boundary="${spec.boundary}"`);
  lines.push("");
  lines.push(`--${spec.boundary}`);
  lines.push('Content-Type: text/plain; charset="us-ascii"');
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(...spec.bodyText.split("\n"));
  lines.push("");
  lines.push(`--${spec.boundary}`);
  lines.push(`Content-Type: application/pdf; name="${spec.attachment.filename}"`);
  lines.push("Content-Transfer-Encoding: base64");
  lines.push(`Content-Disposition: attachment; filename="${spec.attachment.filename}"`);
  lines.push("");
  lines.push(...base64Lines(spec.attachment.bytes));
  lines.push(`--${spec.boundary}--`);
  lines.push("");
  return Buffer.from(lines.join("\r\n"), "ascii");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const requestPdf = await renderPdf(
    {
      Title: "Material list: Bryan shop expansion",
      Author: "Rita Alvarez, Brazos Valley Fabricators",
      Subject: "Steel list for the Bryan shop expansion",
      date: REQUEST_PDF_DATE,
    },
    drawRequestPdf,
  );

  const quotePdf = await renderPdf(
    {
      Title: "Quotation 4417",
      Author: "Marcus Reed, Delta Steel Houston",
      Subject: "RE: RFQ: Lone Star, 4 items",
      date: QUOTE_PDF_DATE,
    },
    drawQuotePdf,
  );

  const requestEml = buildEml({
    headers: [
      ["From", '"Rita Alvarez" <rita@brazosfab.example.com>'],
      ["To", `Caleb <${BROKER_EMAIL}>`],
      ["Subject", "Steel list for the Bryan shop expansion"],
      ["Date", REQUEST_EMAIL_DATE],
      ["Message-ID", "<7f8e9d.bryan@brazosfab.example.com>"],
    ],
    boundary: "----=_Part_bryan_7f8e9d",
    bodyText: "See attached list. Need everything on site by Nov 10.\n\nThanks,\nRita",
    attachment: { filename: "bryan-shop-list.pdf", bytes: requestPdf },
  });

  const quoteEml = buildEml({
    headers: [
      ["From", '"Marcus Reed" <marcus.reed@example.com>'],
      ["To", BROKER_EMAIL],
      ["Subject", "RE: RFQ: Lone Star, 4 items"],
      ["Date", QUOTE_EMAIL_DATE],
      ["Message-ID", "<q-20261022-0417@example.com>"],
      ["In-Reply-To", RFQ_MESSAGE_ID],
      ["References", RFQ_MESSAGE_ID],
    ],
    boundary: "----=_Part_delta_4417",
    bodyText: "Quote attached. Let me know.\n\nMarcus",
    attachment: { filename: "delta-quote-4417.pdf", bytes: quotePdf },
  });

  const outputs: [string, Buffer][] = [
    [requestFixturePath("pdf-list.pdf"), requestPdf],
    [requestFixturePath("pdf-list.eml"), requestEml],
    [replyFixturePath("quote.pdf"), quotePdf],
    [replyFixturePath("quote.pdf.eml"), quoteEml],
  ];
  for (const [file, bytes] of outputs) {
    writeFileSync(file, bytes);
    console.log(`wrote ${file} (${bytes.length} bytes)`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
