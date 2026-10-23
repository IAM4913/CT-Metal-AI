// Guards the PRD section 15 fixtures: every file exists, the .eml files parse as
// real mail with the agreed headers and bodies, and the PDFs yield the agreed
// designations as text. Runs offline; pdf-parse works on the in-memory bytes.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { simpleParser, type ParsedMail } from "mailparser";
import { PDFParse } from "pdf-parse";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_ATTACHMENTS,
  REPLY_FIXTURES,
  REQUEST_FIXTURES,
  fixtureRoot,
  readFixture,
  replyFixturePath,
  requestFixturePath,
} from "./fixtures";

const EM_DASH = String.fromCharCode(0x2014); // built from the code point so this file itself contains none
const RFQ_MESSAGE_ID = "<anvil-rfq-00000000-0000-4000-8000-000000000000@noop.anvil.local>";

async function parseEml(relPath: string): Promise<ParsedMail> {
  return simpleParser(readFixture(relPath));
}

async function pdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return { text: result.text, pages: result.total };
  } finally {
    await parser.destroy();
  }
}

function fromAddress(mail: ParsedMail): string | undefined {
  return mail.from?.value[0]?.address;
}

function fromName(mail: ParsedMail): string | undefined {
  return mail.from?.value[0]?.name;
}

function referencesList(mail: ParsedMail): string[] {
  if (mail.references === undefined) return [];
  return Array.isArray(mail.references) ? mail.references : [mail.references];
}

describe("fixture files", () => {
  const allPaths = [
    ...REQUEST_FIXTURES.map((n) => requestFixturePath(n)),
    ...REPLY_FIXTURES.map((n) => replyFixturePath(n)),
    ...FIXTURE_ATTACHMENTS.map((rel) => path.join(fixtureRoot(), rel)),
  ];

  it("lists five request and five reply fixtures", () => {
    expect(REQUEST_FIXTURES).toHaveLength(5);
    expect(REPLY_FIXTURES).toHaveLength(5);
  });

  it.each(allPaths)("%s exists and is non-empty", (file) => {
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);
  });

  it("has no stray files beside the listed ones (except .gitkeep)", () => {
    const root = fixtureRoot();
    const onDisk = [
      ...readdirSync(path.join(root, "requests")).map((n) => `requests/${n}`),
      ...readdirSync(path.join(root, "replies")).map((n) => `replies/${n}`),
    ].filter((n) => !n.endsWith(".gitkeep"));
    const expected = [
      ...REQUEST_FIXTURES.map((n) => `requests/${n}`),
      ...REPLY_FIXTURES.map((n) => `replies/${n}`),
      ...FIXTURE_ATTACHMENTS,
    ];
    expect(onDisk.sort()).toEqual([...expected].sort());
  });

  it("contains no em dashes in any text or eml fixture", () => {
    const textFiles = allPaths.filter((p) => p.endsWith(".txt") || p.endsWith(".eml"));
    for (const file of textFiles) {
      expect(readFixture(path.relative(fixtureRoot(), file)).toString("utf8"), file).not.toContain(EM_DASH);
    }
  });

  it("readFixture refuses paths outside fixtures/", () => {
    expect(() => readFixture("../package.json")).toThrow(/escapes/);
  });
});

describe("request text fixtures (PRD section 15 wording)", () => {
  it("single-hss.txt", () => {
    const text = readFixture("requests/single-hss.txt").toString("utf8");
    expect(text).toBe(
      "Need pricing on 100 pcs 8x8x5/8 HSS, 40' lengths, A500 Gr B, delivered Fort Worth. If 5/8 is too heavy can look at 3/8.\n",
    );
  });

  it("channel-heavier.txt", () => {
    const text = readFixture("requests/channel-heavier.txt").toString("utf8");
    expect(text).toBe("12 inch channel 30# or heavier, 6 pcs at 40 ft\n");
  });

  it("ambiguous.txt", () => {
    const text = readFixture("requests/ambiguous.txt").toString("utf8");
    expect(text).toBe(
      "8 square 3/8 x 40 - 20 pcs, also 1/2 wall if 3/8 not available, and some angle for clips\n",
    );
  });
});

describe("reply text fixtures", () => {
  it("alt-wall-rolling.txt names the alternate wall, stock, and a per-cwt price", () => {
    const text = readFixture("replies/alt-wall-rolling.txt").toString("utf8");
    expect(text).toContain("3/8 wall is booked through December, nothing on the floor.");
    expect(text).toContain("We can offer 8x8x1/2 from stock, 40', $64.50/cwt FOB mill.");
  });

  it("partial-discount.txt names 60 pcs, a per-ft price, separate freight, and 1% net 10", () => {
    const text = readFixture("replies/partial-discount.txt").toString("utf8");
    expect(text).toContain("Have 60 pcs in stock at $0.98/ft, freight separate, 1% net 10.");
  });

  it("future-rolling.txt names the rolling week and the cut, with no price", () => {
    const text = readFixture("replies/future-rolling.txt").toString("utf8");
    expect(text).toContain("Rolling week of Nov 17, five loads, can cut 40'.");
    expect(text).not.toContain("$");
  });

  it("decline.txt declines channel", () => {
    const text = readFixture("replies/decline.txt").toString("utf8");
    expect(text).toContain("Sorry, we don't stock channel.");
  });
});

describe("mixed-list.eml", () => {
  it("parses with the agreed headers and a body the parser can read", async () => {
    const mail = await parseEml("requests/mixed-list.eml");
    expect(fromAddress(mail)).toBe("dale@lonestarfab.example.com");
    expect(fromName(mail)).toBe("Dale Hutchins");
    expect(mail.to && !Array.isArray(mail.to) ? mail.to.value[0]?.address : undefined).toBe(
      "caleb@example.com",
    );
    expect(mail.subject).toBe("Material list for Job 4471");
    expect(mail.messageId).toBe("<a1b2c3d4.4471@lonestarfab.example.com>");
    expect(mail.date?.getUTCFullYear()).toBe(2026);
    expect(mail.date?.getUTCMonth()).toBe(9);
    expect(mail.attachments).toHaveLength(0);

    const text = mail.text ?? "";
    expect(text).toContain("W12x26 x 50' qty 8");
    expect(text).toContain("L2x2x1/4 x 20' qty 40");
    expect(text).toContain("3/8 plate 48x96 qty 10 A36");
    expect(text).toContain("6\" sq 3/8 x 24' qty 20");
    expect(text).toContain("Deliver to the Fort Worth yard, need it by the 15th.");
    // Signature block and the quoted earlier thread are present for the parser to ignore.
    expect(text).toContain("Purchasing\nLone Star Fabrication");
    expect(text).toContain("Caleb <caleb@example.com> wrote:");
    expect(text).toContain("> Dale, the 6 pcs of C8x11.5 for Job 4402");

    // The html alternative carries the same items.
    const html = typeof mail.html === "string" ? mail.html : "";
    expect(html).toContain("W12x26 x 50' qty 8");
    expect(html).toContain("<blockquote");
  });
});

describe("pdf-list.eml and pdf-list.pdf", () => {
  it("parses with the agreed headers, body, and one PDF attachment equal to pdf-list.pdf", async () => {
    const mail = await parseEml("requests/pdf-list.eml");
    expect(fromAddress(mail)).toBe("rita@brazosfab.example.com");
    expect(fromName(mail)).toBe("Rita Alvarez");
    expect(mail.subject).toBe("Steel list for the Bryan shop expansion");
    expect(mail.messageId).toBe("<7f8e9d.bryan@brazosfab.example.com>");
    expect(mail.text).toContain("See attached list. Need everything on site by Nov 10.");
    expect(mail.text).toContain("Rita");

    expect(mail.attachments).toHaveLength(1);
    const [attachment] = mail.attachments;
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.filename).toBe("bryan-shop-list.pdf");
    expect(attachment.content.equals(readFixture("requests/pdf-list.pdf"))).toBe(true);
  });

  it("yields every contract designation as text on one page", async () => {
    const { text, pages } = await pdfText(readFixture("requests/pdf-list.pdf"));
    expect(pages).toBe(1);
    for (const designation of ["HSS4x4x1/4", "W8x18", "L3x3x1/4", "PL1/2", "PIPE2STD"]) {
      expect(text).toContain(designation);
    }
    expect(text).toContain("Brazos Valley Fabricators");
    expect(text).not.toContain(EM_DASH);
  });
});

describe("quote.pdf.eml and quote.pdf", () => {
  it("parses as a threaded reply with one PDF attachment equal to quote.pdf", async () => {
    const mail = await parseEml("replies/quote.pdf.eml");
    expect(fromAddress(mail)).toBe("marcus.reed@example.com");
    expect(fromName(mail)).toBe("Marcus Reed");
    expect(mail.subject).toBe("RE: RFQ: Lone Star, 4 items");
    expect(mail.messageId).toBe("<q-20261022-0417@example.com>");
    expect(mail.inReplyTo).toBe(RFQ_MESSAGE_ID);
    expect(referencesList(mail)).toContain(RFQ_MESSAGE_ID);
    expect(mail.text).toContain("Quote attached. Let me know.");
    expect(mail.text).toContain("Marcus");

    expect(mail.attachments).toHaveLength(1);
    const [attachment] = mail.attachments;
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.filename).toBe("delta-quote-4417.pdf");
    expect(attachment.content.equals(readFixture("replies/quote.pdf"))).toBe(true);
  });

  it("yields every contract item and the terms footer as text on one page", async () => {
    const { text, pages } = await pdfText(readFixture("replies/quote.pdf"));
    expect(pages).toBe(1);
    for (const needle of ["W12x26", "L2x2x1/4", "PL3/8", "HSS6x6x3/8", "Net 30", "1%"]) {
      expect(text).toContain(needle);
    }
    expect(text).toContain("$62.50");
    expect(text).toContain("rolling 11/17");
    expect(text).toContain("Freight included to Fort Worth");
    expect(text).not.toContain(EM_DASH);
  });
});
