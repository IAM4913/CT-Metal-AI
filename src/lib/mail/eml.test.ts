import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFixture } from "@/lib/fixtures";
import { htmlToText, parseEml, parsedEmlHeadersSchema } from "./eml";

const RFQ_MESSAGE_ID = "<anvil-rfq-00000000-0000-4000-8000-000000000000@noop.anvil.local>";
const HEX_64 = /^[0-9a-f]{64}$/;

function rawMessage(headers: string[], body: string): string {
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

describe("parseEml: mixed-list.eml", () => {
  it("returns the headers, the text/plain body with signature and quoted thread, and the html alternative", async () => {
    const parsed = await parseEml(readFixture("requests/mixed-list.eml"));

    expect(parsed.from).toEqual({ name: "Dale Hutchins", address: "dale@lonestarfab.example.com" });
    expect(parsed.to).toEqual(["caleb@example.com"]);
    expect(parsed.cc).toEqual([]);
    expect(parsed.subject).toBe("Material list for Job 4471");
    expect(parsed.messageId).toBe("<a1b2c3d4.4471@lonestarfab.example.com>");
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.references).toEqual([]);
    expect(parsed.date?.toISOString()).toBe("2026-10-21T14:32:00.000Z");

    for (const item of ["W12x26 x 50' qty 8", "L2x2x1/4 x 20' qty 40", "3/8 plate 48x96 qty 10 A36", '6" sq 3/8 x 24\' qty 20']) {
      expect(parsed.text).toContain(item);
    }
    expect(parsed.text).toContain("Purchasing\nLone Star Fabrication");
    expect(parsed.text).toContain("(817) 555-0142");
    expect(parsed.text).toContain("Caleb <caleb@example.com> wrote:");
    expect(parsed.text).toContain("> Dale, the 6 pcs of C8x11.5 for Job 4402");

    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.html).not.toBeNull();
    expect(parsed.html).toContain("<blockquote");
  });

  it("accepts a string as well as a Buffer", async () => {
    const fromBuffer = await parseEml(readFixture("requests/mixed-list.eml"));
    const fromString = await parseEml(readFixture("requests/mixed-list.eml").toString("utf8"));
    expect(fromString.text).toBe(fromBuffer.text);
    expect(fromString.messageId).toBe(fromBuffer.messageId);
  });

  it("passes parsedEmlHeadersSchema, which strips the body fields", async () => {
    const parsed = await parseEml(readFixture("requests/mixed-list.eml"));
    const headers = parsedEmlHeadersSchema.parse(parsed);
    expect(headers).toEqual({
      from: { name: "Dale Hutchins", address: "dale@lonestarfab.example.com" },
      to: ["caleb@example.com"],
      cc: [],
      subject: "Material list for Job 4471",
      date: parsed.date,
      messageId: "<a1b2c3d4.4471@lonestarfab.example.com>",
      inReplyTo: null,
      references: [],
    });
    expect(headers).not.toHaveProperty("text");
  });

  it("parsedEmlHeadersSchema rejects malformed headers and trims addresses", async () => {
    const parsed = await parseEml(readFixture("requests/mixed-list.eml"));
    const rejects = (patch: Record<string, unknown>) =>
      parsedEmlHeadersSchema.safeParse({ ...parsed, ...patch }).success === false;

    expect(parsedEmlHeadersSchema.safeParse(parsed).success).toBe(true);
    expect(rejects({ from: { name: null, address: "no-at-sign" } })).toBe(true);
    expect(rejects({ from: { name: null, address: "@" } })).toBe(true);
    expect(rejects({ to: ["a b@example.com"] })).toBe(true);
    expect(rejects({ cc: ["caleb@example.com", ""] })).toBe(true);
    expect(rejects({ date: "2026-10-21" })).toBe(true);
    expect(rejects({ date: new Date("not a date") })).toBe(true);
    expect(rejects({ references: "single" })).toBe(true);
    expect(rejects({ subject: 42 })).toBe(true);
    expect(rejects({ messageId: undefined })).toBe(true);

    const trimmed = parsedEmlHeadersSchema.parse({ ...parsed, to: [" caleb@example.com "] });
    expect(trimmed.to).toEqual(["caleb@example.com"]);
  });
});

describe("parseEml: pdf-list.eml", () => {
  it("returns one PDF attachment with filename, size, and sha256 of the bytes", async () => {
    const parsed = await parseEml(readFixture("requests/pdf-list.eml"));
    expect(parsed.from?.address).toBe("rita@brazosfab.example.com");
    expect(parsed.text).toContain("See attached list. Need everything on site by Nov 10.");

    expect(parsed.attachments).toHaveLength(1);
    const [pdf] = parsed.attachments;
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.filename).toBe("bryan-shop-list.pdf");
    expect(pdf.sha256).toMatch(HEX_64);
    expect(pdf.size).toBe(pdf.content.length);
    expect(pdf.size).toBeGreaterThan(0);

    const standalone = readFixture("requests/pdf-list.pdf");
    expect(pdf.content.equals(standalone)).toBe(true);
    expect(pdf.sha256).toBe(createHash("sha256").update(standalone).digest("hex"));
  });
});

describe("parseEml: quote.pdf.eml", () => {
  it("populates inReplyTo and references from the threading headers", async () => {
    const parsed = await parseEml(readFixture("replies/quote.pdf.eml"));
    expect(parsed.inReplyTo).toBe(RFQ_MESSAGE_ID);
    expect(parsed.references).toEqual([RFQ_MESSAGE_ID]);
    expect(parsed.messageId).toBe("<q-20261022-0417@example.com>");
    expect(parsed.subject).toBe("RE: RFQ: Lone Star, 4 items");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("delta-quote-4417.pdf");
  });
});

describe("parseEml: synthetic messages", () => {
  const htmlBody =
    "<html><head><style>p { color: red }</style></head><body>" +
    "<p>Caleb,</p>" +
    "<p>W12x26 x 50&#39; qty 8<br>\n   L2x2x1/4 x 20&#39; qty 40</p>" +
    "<p>Thanks &amp; regards,<br>Dale</p>" +
    "</body></html>";

  it("falls back to htmlToText when the message has only an html part", async () => {
    const raw = rawMessage(
      [
        "From: Dale <dale@lonestarfab.example.com>",
        "To: caleb@example.com",
        "Cc: shop@lonestarfab.example.com, Rita <rita@brazosfab.example.com>",
        "Subject: html only",
        "Date: Wed, 21 Oct 2026 09:32:00 -0500",
        "Message-ID: <html-only@lonestarfab.example.com>",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
      ],
      htmlBody,
    );
    const parsed = await parseEml(raw);
    expect(parsed.html).toBe(htmlBody);
    expect(parsed.text).toBe(htmlToText(htmlBody));
    expect(parsed.text).toBe("Caleb,\n\nW12x26 x 50' qty 8\nL2x2x1/4 x 20' qty 40\n\nThanks & regards,\nDale");
    expect(parsed.cc).toEqual(["shop@lonestarfab.example.com", "rita@brazosfab.example.com"]);
    expect(parsed.from).toEqual({ name: "Dale", address: "dale@lonestarfab.example.com" });
  });

  it("keeps one item per line when an html-only message wraps the list in pre", async () => {
    const preBody =
      '<html><body><pre class="moz-quote-pre" wrap="">' +
      "W12x26 x 50' qty 8\nL2x2x1/4 x 20' qty 40\n3/8 plate 48x96 qty 10\n" +
      "</pre><p>Thanks,<br>Dale</p></body></html>";
    const raw = rawMessage(
      [
        "From: Dale <dale@lonestarfab.example.com>",
        "To: caleb@example.com",
        "Subject: pre list",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
      ],
      preBody,
    );
    const parsed = await parseEml(raw);
    expect(parsed.text).toBe("W12x26 x 50' qty 8\nL2x2x1/4 x 20' qty 40\n3/8 plate 48x96 qty 10\n\nThanks,\nDale");
    expect(parsed.text.split("\n").slice(0, 3)).toEqual([
      "W12x26 x 50' qty 8",
      "L2x2x1/4 x 20' qty 40",
      "3/8 plate 48x96 qty 10",
    ]);
  });

  it("prefers the text/plain part when it has content", async () => {
    const raw = rawMessage(
      [
        "From: dale@lonestarfab.example.com",
        "To: caleb@example.com",
        "Subject: both parts",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="b1"',
      ],
      [
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "plain wins",
        "--b1",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>html loses</p>",
        "--b1--",
      ].join("\r\n"),
    );
    const parsed = await parseEml(raw);
    expect(parsed.text.trim()).toBe("plain wins");
    expect(parsed.html).toBe("<p>html loses</p>");
    expect(parsed.from).toEqual({ name: null, address: "dale@lonestarfab.example.com" });
    expect(parsed.date).toBeNull();
    expect(parsed.messageId).toBeNull();
  });

  it("returns empty text and null html when there is no body", async () => {
    const parsed = await parseEml(rawMessage(["From: a@example.com", "To: b@example.com", "Subject: empty"], ""));
    expect(parsed.text).toBe("");
    expect(parsed.html).toBeNull();
    expect(parsed.subject).toBe("empty");
  });

  const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const pdfBytes = Buffer.from("%PDF-1.3 fake").toString("base64");

  function mixedWithInlineImage(includePdf: boolean): string {
    const parts = [
      "--mix",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Quote attached</p><img src="cid:logo@x">',
      "--mix",
      'Content-Type: image/png; name="logo.png"',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@x>",
      'Content-Disposition: inline; filename="logo.png"',
      "",
      pngBytes,
    ];
    if (includePdf) {
      parts.push(
        "--mix",
        'Content-Type: application/pdf; name="quote.pdf"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="quote.pdf"',
        "",
        pdfBytes,
      );
    }
    parts.push("--mix--");
    return rawMessage(
      [
        "From: v@example.com",
        "To: caleb@example.com",
        "Subject: inline image",
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="mix"',
      ],
      parts.join("\r\n"),
    );
  }

  it("drops inline images when a real attachment is present", async () => {
    const parsed = await parseEml(mixedWithInlineImage(true));
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["quote.pdf"]);
    expect(parsed.attachments[0].contentType).toBe("application/pdf");
    expect(parsed.attachments[0].content.toString("utf8")).toBe("%PDF-1.3 fake");
    expect(parsed.text).toBe("Quote attached");
  });

  it("keeps inline images when they are the only attachments", async () => {
    const parsed = await parseEml(mixedWithInlineImage(false));
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["logo.png"]);
    expect(parsed.attachments[0].contentType).toBe("image/png");
    expect(parsed.attachments[0].sha256).toMatch(HEX_64);
  });
});

describe("htmlToText", () => {
  it("turns block tags and br into line breaks and collapses blank runs", () => {
    expect(htmlToText("<p>Hello</p><p>World</p>")).toBe("Hello\n\nWorld");
    expect(htmlToText("<div>a<br>b<br/>c<BR />d</div>")).toBe("a\nb\nc\nd");
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("one\ntwo");
    expect(htmlToText("<table><tr><td>W12x26</td><td>8 pcs</td></tr><tr><td>L2x2x1/4</td><td>40 pcs</td></tr></table>")).toBe(
      "W12x26 8 pcs\nL2x2x1/4 40 pcs",
    );
    expect(htmlToText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  it("collapses source whitespace like a browser before adding line breaks", () => {
    expect(htmlToText("<p>W12x26 x 50' qty 8<br>\n   L2x2x1/4 x 20' qty 40</p>")).toBe(
      "W12x26 x 50' qty 8\nL2x2x1/4 x 20' qty 40",
    );
    expect(htmlToText("  <div>\n  spaced   out\n  </div>  ")).toBe("spaced out");
  });

  it("keeps line breaks inside pre blocks", () => {
    expect(htmlToText("<pre>a\nb</pre>")).toBe("a\nb");
    expect(htmlToText("<pre>W12x26 x 50'\nL2x2x1/4 x 20'</pre>")).toBe("W12x26 x 50'\nL2x2x1/4 x 20'");
    expect(htmlToText('<PRE wrap="">a\r\nb\r\n</PRE>')).toBe("a\nb");
    expect(htmlToText("<p>Hi</p><pre>\na\nb\n</pre><p>Thanks</p>")).toBe("Hi\n\na\nb\n\nThanks");
    // Runs of spaces inside pre still collapse; only the line structure is kept.
    expect(htmlToText("<pre>W12x26   x 50'\n  L2x2</pre>")).toBe("W12x26 x 50'\nL2x2");
  });

  it("drops script, style, head, and comments", () => {
    expect(
      htmlToText(
        "<html><head><title>t</title><style>p{color:red}</style></head><body><script>alert(1)</script><!-- note --><p>kept</p></body></html>",
      ),
    ).toBe("kept");
    expect(htmlToText("<SCRIPT type='x'>a<b</SCRIPT>text")).toBe("text");
  });

  it("strips every remaining tag including attributes and doctype", () => {
    expect(htmlToText('<!DOCTYPE html><span style="font-weight:bold">bold</span> and <a href="x">link</a>')).toBe(
      "bold and link",
    );
    expect(htmlToText("3 < 4 and 5 > 2")).toBe("3 < 4 and 5 > 2");
  });

  it("decodes the common entities in one pass", () => {
    expect(htmlToText("Caleb &lt;caleb@example.com&gt; wrote:")).toBe("Caleb <caleb@example.com> wrote:");
    expect(htmlToText("Smith &amp; Sons")).toBe("Smith & Sons");
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
    expect(htmlToText("&quot;6&quot; sq&quot;")).toBe('"6" sq"');
    expect(htmlToText("50&#39; and 50&#x27; and 50&apos;")).toBe("50' and 50' and 50'");
    expect(htmlToText("a&nbsp;&nbsp;b")).toBe("a b");
    expect(htmlToText("1&frac12; pipe")).toBe("1½ pipe");
    expect(htmlToText("&unknown; stays")).toBe("&unknown; stays");
    expect(htmlToText("&#0; dropped?")).toBe("&#0; dropped?");
  });

  it("renders the mixed-list html alternative as one item per line with the quoted thread", async () => {
    const parsed = await parseEml(readFixture("requests/mixed-list.eml"));
    const text = htmlToText(parsed.html ?? "");
    const lines = text.split("\n");
    expect(lines).toContain("W12x26 x 50' qty 8");
    expect(lines).toContain("L2x2x1/4 x 20' qty 40");
    expect(lines).toContain("3/8 plate 48x96 qty 10 A36");
    expect(lines).toContain('6" sq 3/8 x 24\' qty 20');
    expect(lines).toContain("Lone Star Fabrication");
    expect(text).toContain("On Mon, Oct 19, 2026 at 2:14 PM Caleb <caleb@example.com> wrote:");
    expect(text).toContain("Dale, the 6 pcs of C8x11.5 for Job 4402");
    // No tag survives; the decoded "<caleb@example.com>" is not a tag.
    expect(text).not.toMatch(/<\/?[a-z][a-z0-9]*(?:\s[^>]*)?>/i);
    expect(text).not.toContain("\n\n\n");
  });

  it("is deterministic and returns an empty string for empty input", () => {
    const html = "<p>a<br>b</p>";
    expect(htmlToText(html)).toBe(htmlToText(html));
    expect(htmlToText("")).toBe("");
    expect(htmlToText("   \n  ")).toBe("");
  });
});
