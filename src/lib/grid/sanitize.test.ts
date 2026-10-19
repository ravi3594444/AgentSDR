import { expect, test } from "bun:test";
import { cleanJson, cleanString, clippedString } from "./sanitize";

test("strips NUL and replaces lone surrogates", () => {
  expect(cleanString("a\u0000b")).toBe("ab");
  expect(cleanString("x\uD800y")).toBe("x�y");
  expect(cleanString("x\uDC00y")).toBe("x�y");
  expect(cleanString("ok 😀")).toBe("ok 😀");
});

test("cleans nested values and keys", () => {
  expect(cleanJson<unknown>({ "k\u0000": ["a\u0000", { n: 1, s: "\uD800" }], d: null })).toEqual({
    k: ["a", { n: 1, s: "�" }],
    d: null,
  });
});

test("clips to a length without splitting a character", () => {
  expect(clippedString("short", 10)).toBe("short");
  expect(clippedString("abcdefghij", 5)).toBe("abcd…");
  // An emoji is two code units: the cut never leaves half of one.
  const clipped = clippedString(`abc${"😀".repeat(5)}`, 5);
  expect(clipped).toBe("abc…");
  expect(clippedString("a\u0000bc", 3)).toBe("abc");
});
