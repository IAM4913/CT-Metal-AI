// Seed login resolution for scripts/seed.ts, kept pure (no process, no
// database) so scripts/seed-env.test.ts can cover it.
//
// The committed .env.local.example pre-fills SEED_USER_EMAIL and
// SEED_USER_PASSWORD with the same placeholder strings used as fallbacks here,
// and SETUP.md says to copy that file. So a value equal to the placeholder is
// treated exactly like an unset or blank one: the seed still runs with the
// placeholder login, but it warns that the login is the committed placeholder.
// A hosted project must never be seeded with the public password in silence.

export const DEFAULT_SEED_USER_EMAIL = "michael@example.com";
export const DEFAULT_SEED_USER_PASSWORD = "change-me-before-demo";

export type SeedLogin = {
  userEmail: string;
  userPassword: string;
  /** Variables that resolved to the placeholder: unset, blank, or equal to the committed value. */
  placeholders: string[];
};

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Resolve the seed login from an environment, flagging placeholder values. */
export function resolveSeedLogin(env: EnvLike): SeedLogin {
  const placeholders: string[] = [];
  const userEmail = resolveOne(
    "SEED_USER_EMAIL",
    env.SEED_USER_EMAIL,
    DEFAULT_SEED_USER_EMAIL,
    (a, b) => a.toLowerCase() === b.toLowerCase(),
    placeholders,
  );
  const userPassword = resolveOne(
    "SEED_USER_PASSWORD",
    env.SEED_USER_PASSWORD,
    DEFAULT_SEED_USER_PASSWORD,
    (a, b) => a === b,
    placeholders,
  );
  return { userEmail, userPassword, placeholders };
}

function resolveOne(
  name: string,
  value: string | undefined,
  fallback: string,
  same: (a: string, b: string) => boolean,
  placeholders: string[],
): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || same(trimmed, fallback)) {
    placeholders.push(name);
    return fallback;
  }
  return trimmed;
}

/** The warning to print when any part of the login is a placeholder, or null. */
export function placeholderWarning(login: SeedLogin): string | null {
  if (login.placeholders.length === 0) return null;
  const names = login.placeholders.join(" and ");
  const verb = login.placeholders.length > 1 ? "are" : "is";
  return `warning: ${names} ${verb} unset or still the committed placeholder from .env.local.example, so the seed login is ${login.userEmail} with the placeholder password. Set real values in .env.local before the demo.`;
}
