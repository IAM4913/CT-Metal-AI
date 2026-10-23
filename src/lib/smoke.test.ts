import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs vitest with the @ alias configured", async () => {
    const mod = await import("@/lib/smoke.test");
    expect(mod).toBeDefined();
    expect(1 + 1).toBe(2);
  });
});
