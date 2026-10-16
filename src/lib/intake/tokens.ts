import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The secret a website-form endpoint is called with. Shown to the owner once
 * when the endpoint is made (or its token rotated); only its SHA-256 is
 * stored (intake_endpoints.token_hash, unique), which is how a delivery
 * finds its endpoint and so its organization. The last four characters are
 * kept as a hint so endpoints can be told apart. Pure; tested in
 * tokens.test.ts.
 */

export const INTAKE_TOKEN_PREFIX = "agsdr_form_";
/** 32 random bytes as base64url, without padding. */
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

export type IntakeToken = { token: string; hash: string; hint: string };

export function hashIntakeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function intakeTokenHint(token: string): string {
  return token.slice(-4);
}

export function generateIntakeToken(): IntakeToken {
  const token = `${INTAKE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashIntakeToken(token), hint: intakeTokenHint(token) };
}

/** Whether a value has the shape of a token, so a stray header is refused without a database read. */
export function looksLikeIntakeToken(value: string | null | undefined): value is string {
  return typeof value === "string"
    && value.startsWith(INTAKE_TOKEN_PREFIX)
    && TOKEN_BODY.test(value.slice(INTAKE_TOKEN_PREFIX.length));
}

/**
 * Compares two secrets (or their hashes) in constant time. Both sides are
 * hashed first, so the comparison takes the same time whatever their
 * lengths and wherever they differ.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
