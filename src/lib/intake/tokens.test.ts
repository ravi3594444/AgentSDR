import { describe, expect, test } from "bun:test";
import { generateIntakeToken, hashIntakeToken, INTAKE_TOKEN_PREFIX, intakeTokenHint, looksLikeIntakeToken, secretsMatch } from "./tokens";

describe("generateIntakeToken", () => {
  test("is the prefix and 32 random bytes as base64url, with its hash and last-four hint", () => {
    const { token, hash, hint } = generateIntakeToken();
    expect(token.startsWith(INTAKE_TOKEN_PREFIX)).toBe(true);
    const body = token.slice(INTAKE_TOKEN_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(body, "base64url").length).toBe(32);
    expect(hash).toBe(hashIntakeToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hint).toBe(token.slice(-4));
  });

  test("never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateIntakeToken().token));
    expect(tokens.size).toBe(200);
  });
});

describe("hashIntakeToken", () => {
  test("is the SHA-256 of the token, hex", () => {
    expect(hashIntakeToken("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(hashIntakeToken("a")).not.toBe(hashIntakeToken("b"));
  });
});

describe("intakeTokenHint", () => {
  test("is the last four characters", () => {
    expect(intakeTokenHint("agsdr_form_xyzAB12")).toBe("AB12");
  });
});

describe("looksLikeIntakeToken", () => {
  test("accepts a generated token", () => {
    expect(looksLikeIntakeToken(generateIntakeToken().token)).toBe(true);
  });

  test("refuses anything else before a database read", () => {
    const { token } = generateIntakeToken();
    expect(looksLikeIntakeToken(null)).toBe(false);
    expect(looksLikeIntakeToken("")).toBe(false);
    expect(looksLikeIntakeToken(token.slice(INTAKE_TOKEN_PREFIX.length))).toBe(false);
    expect(looksLikeIntakeToken(`${token}x`)).toBe(false);
    expect(looksLikeIntakeToken(token.slice(0, -1))).toBe(false);
    expect(looksLikeIntakeToken(`${INTAKE_TOKEN_PREFIX}${"a".repeat(42)}=`)).toBe(false);
    expect(looksLikeIntakeToken(`Bearer ${token}`)).toBe(false);
  });
});

describe("secretsMatch", () => {
  test("is true only for identical values, whatever their lengths", () => {
    const { token, hash } = generateIntakeToken();
    expect(secretsMatch(hashIntakeToken(token), hash)).toBe(true);
    expect(secretsMatch(token, token)).toBe(true);
    expect(secretsMatch(token, `${token}x`)).toBe(false);
    expect(secretsMatch("", token)).toBe(false);
    expect(secretsMatch(hash.replace(/.$/, (c) => (c === "0" ? "1" : "0")), hash)).toBe(false);
  });
});
