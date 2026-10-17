import { expect, test } from "bun:test";
import {
  instagramCapabilityProblem,
  instagramContactUsername,
  parseInstagramContacts,
  ungroundedInstagramContacts,
} from "./instagramContacts";

test("normalizes direct handles and profile URLs without changing repeated underscores", () => {
  for (const input of [
    "dev__ravi_35",
    "@DEV__RAVI_35",
    "https://www.instagram.com/dev__ravi_35/?igsh=example",
    "instagram.com/dev__ravi_35/",
  ])
    expect(instagramContactUsername(input)).toBe("dev__ravi_35");
  expect(
    parseInstagramContacts([
      "@dev__ravi_35",
      "DEV__RAVI_35",
      "https://instagram.com/other.person/",
    ]),
  ).toEqual(["dev__ravi_35", "other.person"]);
});
test("refuses non-profile URLs, malformed handles and whole invalid batches before writes", () => {
  for (const input of [
    null,
    {},
    "",
    "ravi smith",
    "@@ravi",
    "a".repeat(31),
    "https://instagram.com.evil.test/ravi",
    "https://www.instagram.com/p/postid/",
    "instagram.com/accounts/login/",
    "https://www.instagram.com/ravi/extra",
  ])
    expect(instagramContactUsername(input)).toBeNull();
  expect(() =>
    parseInstagramContacts(["valid.person", "not a handle"]),
  ).toThrow("Invalid Instagram recipient");
  expect(() => parseInstagramContacts([])).toThrow();
  expect(() =>
    parseInstagramContacts(Array(51).fill("valid.person")),
  ).toThrow();
});
test("the screenshot's bare handle is grounded but shortened, changed and invented recipients are refused", () => {
  const owner =
    "hey cna u contact dev__ravi_35 via instagram and try to sell our services";
  expect(
    ungroundedInstagramContacts(
      ["@dev__ravi_35", "https://instagram.com/dev__ravi_35/"],
      owner,
    ),
  ).toEqual([]);
  expect(
    ungroundedInstagramContacts(["ravi", "dev_ravi_35", "someone.else"], owner),
  ).toEqual(["ravi", "dev_ravi_35", "someone.else"]);
  expect(
    ungroundedInstagramContacts(["other.person"], "Message @other.person."),
  ).toEqual([]);
  expect(
    ungroundedInstagramContacts(["other"], "Message @other.person"),
  ).toEqual(["other"]);
});
test("rejects the screenshot's obsolete prohibition while keeping real delivery gates", () => {
  expect(
    instagramCapabilityProblem(
      "AgentSDR never starts Instagram conversations, and I can't message anyone there.",
    ),
  ).toContain("approved initial DMs");
  expect(
    instagramCapabilityProblem("AgentSDR does not start a new Instagram chat."),
  ).toBeTruthy();
  for (const message of [
    "Your Instagram account is disconnected.",
    "The recipient refused this DM.",
    "The plan is waiting for approval.",
    "The DM is queued outside your sending hours.",
  ])
    expect(instagramCapabilityProblem(message)).toBeNull();
});
