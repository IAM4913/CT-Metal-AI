import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEED_USER_EMAIL,
  DEFAULT_SEED_USER_PASSWORD,
  placeholderWarning,
  resolveSeedLogin,
} from "./seed-env";

/** KEY=value lines of a dotenv file; no quoting or interpolation needed for the example file. */
function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe("resolveSeedLogin", () => {
  it("falls back to the placeholders and names both variables when neither is set", () => {
    const login = resolveSeedLogin({});
    expect(login.userEmail).toBe(DEFAULT_SEED_USER_EMAIL);
    expect(login.userPassword).toBe(DEFAULT_SEED_USER_PASSWORD);
    expect(login.placeholders).toEqual(["SEED_USER_EMAIL", "SEED_USER_PASSWORD"]);
  });

  it("treats blank values like unset ones", () => {
    const login = resolveSeedLogin({ SEED_USER_EMAIL: "   ", SEED_USER_PASSWORD: "" });
    expect(login.placeholders).toEqual(["SEED_USER_EMAIL", "SEED_USER_PASSWORD"]);
  });

  it("treats values equal to the committed placeholders as placeholders", () => {
    const login = resolveSeedLogin({
      SEED_USER_EMAIL: DEFAULT_SEED_USER_EMAIL,
      SEED_USER_PASSWORD: DEFAULT_SEED_USER_PASSWORD,
    });
    expect(login.placeholders).toEqual(["SEED_USER_EMAIL", "SEED_USER_PASSWORD"]);
  });

  it("flags the values a fresh copy of .env.local.example carries (the SETUP.md path)", () => {
    const example = readDotenv(path.resolve(__dirname, "..", ".env.local.example"));
    expect(example.SEED_USER_EMAIL).toBeTruthy();
    expect(example.SEED_USER_PASSWORD).toBeTruthy();
    const login = resolveSeedLogin(example);
    expect(login.placeholders).toEqual(["SEED_USER_EMAIL", "SEED_USER_PASSWORD"]);
  });

  it("compares the email case-insensitively and the password exactly", () => {
    expect(resolveSeedLogin({ SEED_USER_EMAIL: "Michael@Example.com", SEED_USER_PASSWORD: "s3cret-demo" }).placeholders).toEqual([
      "SEED_USER_EMAIL",
    ]);
    expect(
      resolveSeedLogin({ SEED_USER_EMAIL: "caleb@example.com", SEED_USER_PASSWORD: "Change-Me-Before-Demo" }).placeholders,
    ).toEqual([]);
  });

  it("returns trimmed real values with no placeholders", () => {
    const login = resolveSeedLogin({ SEED_USER_EMAIL: " caleb@example.com ", SEED_USER_PASSWORD: " s3cret-demo " });
    expect(login).toEqual({ userEmail: "caleb@example.com", userPassword: "s3cret-demo", placeholders: [] });
  });

  it("names only the variable that is a placeholder", () => {
    const login = resolveSeedLogin({ SEED_USER_EMAIL: "caleb@example.com" });
    expect(login.userEmail).toBe("caleb@example.com");
    expect(login.userPassword).toBe(DEFAULT_SEED_USER_PASSWORD);
    expect(login.placeholders).toEqual(["SEED_USER_PASSWORD"]);
  });
});

describe("placeholderWarning", () => {
  it("is null when the login is real", () => {
    expect(placeholderWarning({ userEmail: "caleb@example.com", userPassword: "s3cret-demo", placeholders: [] })).toBeNull();
  });

  it("names the placeholder variables and the login that will be created", () => {
    const text = placeholderWarning(resolveSeedLogin({}));
    expect(text).toContain("warning:");
    expect(text).toContain("SEED_USER_EMAIL and SEED_USER_PASSWORD are");
    expect(text).toContain(".env.local.example");
    expect(text).toContain(DEFAULT_SEED_USER_EMAIL);
    expect(text).not.toContain(DEFAULT_SEED_USER_PASSWORD);
    expect(placeholderWarning(resolveSeedLogin({ SEED_USER_EMAIL: "caleb@example.com" }))).toContain("SEED_USER_PASSWORD is");
  });
});
