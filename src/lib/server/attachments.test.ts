// Pure parts only: the path rule and filename sanitizer. storeAttachment and
// signedAttachmentUrl talk to Supabase and are type-checked, not run, here.

import { describe, expect, it } from "vitest";
import { ATTACHMENTS_BUCKET, attachmentStoragePath, safeFilename, sha256Hex } from "./attachments";

const BROKER = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);

describe("safeFilename", () => {
  it("keeps letters, digits, dot, dash, and underscore", () => {
    expect(safeFilename("bryan-shop-list.pdf")).toBe("bryan-shop-list.pdf");
    expect(safeFilename("Quote_4417.PDF")).toBe("Quote_4417.PDF");
    expect(safeFilename("mixed-list.eml")).toBe("mixed-list.eml");
  });

  it("replaces each run of other characters with one dash", () => {
    expect(safeFilename("my file (1).pdf")).toBe("my-file-1-.pdf");
    expect(safeFilename("r\u00e9sum\u00e9.pdf")).toBe("r-sum-.pdf");
    expect(safeFilename("a   b\t\tc")).toBe("a-b-c");
    expect(safeFilename("../../etc/passwd")).toBe("..-..-etc-passwd");
    expect(safeFilename("C:\\Users\\dale\\list.xlsx")).toBe("C-Users-dale-list.xlsx");
    expect(safeFilename("list?.pdf#1")).toBe("list-.pdf-1");
  });

  it("trims to 120 characters", () => {
    const long = "x".repeat(200) + ".pdf";
    expect(safeFilename(long)).toBe("x".repeat(120));
    expect(safeFilename("y".repeat(120))).toHaveLength(120);
  });

  it("falls back to attachment when nothing is left", () => {
    expect(safeFilename("")).toBe("attachment");
  });

  it("is idempotent", () => {
    for (const name of ["my file (1).pdf", "", "r\u00e9sum\u00e9.pdf", "plain.txt"]) {
      expect(safeFilename(safeFilename(name))).toBe(safeFilename(name));
    }
  });
});

describe("attachmentStoragePath", () => {
  it("follows {broker_id}/{owner_type}/{owner_id}/{sha256}-{filename}", () => {
    expect(
      attachmentStoragePath({ brokerId: BROKER, ownerType: "request", ownerId: OWNER, sha256: SHA, filename: "mixed-list.eml" }),
    ).toBe(`${BROKER}/request/${OWNER}/${SHA}-mixed-list.eml`);
  });

  it("applies safeFilename to the filename and nothing else", () => {
    expect(
      attachmentStoragePath({
        brokerId: BROKER,
        ownerType: "message",
        ownerId: OWNER,
        sha256: SHA,
        filename: "my quote (final).pdf",
      }),
    ).toBe(`${BROKER}/message/${OWNER}/${SHA}-my-quote-final-.pdf`);
    expect(
      attachmentStoragePath({ brokerId: BROKER, ownerType: "vendor_offer", ownerId: OWNER, sha256: SHA, filename: "" }),
    ).toBe(`${BROKER}/vendor_offer/${OWNER}/${SHA}-attachment`);
  });

  it("has exactly four segments so a filename can never add a path level", () => {
    const path = attachmentStoragePath({
      brokerId: BROKER,
      ownerType: "request",
      ownerId: OWNER,
      sha256: SHA,
      filename: "../../other-broker/secret.pdf",
    });
    expect(path.split("/")).toHaveLength(4);
    expect(path.endsWith(`${SHA}-..-..-other-broker-secret.pdf`)).toBe(true);
  });
});

describe("sha256Hex and bucket name", () => {
  it("hashes bytes to 64 lowercase hex characters", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("uses the attachments bucket from PRD section 11", () => {
    expect(ATTACHMENTS_BUCKET).toBe("attachments");
  });
});
