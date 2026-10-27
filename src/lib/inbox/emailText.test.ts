import { describe, expect, test } from "bun:test";
import { splitQuoted } from "./emailText";

describe("email preview text", () => {
  test("Gmail history stays separate from the new reply", () => {
    const body = "hi bro\n\nOn Wed, 21 Oct, previous@example.test wrote:\n> Older sales pitch";
    expect(splitQuoted(body)).toEqual({ main: "hi bro", quoted: "On Wed, 21 Oct, previous@example.test wrote:\n> Older sales pitch" });
  });
  test("wrapped attribution", () => {
    expect(splitQuoted("New answer\n\nOn Wed, 21 Oct, previous@example.test\nwrote:\nOld").main).toBe("New answer");
  });
  test("Outlook history", () => {
    expect(splitQuoted("New answer\n\nFrom: old@example.test\nSent: Wednesday\nOld").main).toBe("New answer");
  });
  test("forwarded history", () => {
    expect(splitQuoted("New answer\n\n----- Forwarded Message -----\nOld").main).toBe("New answer");
  });
  test("trailing quote block", () => {
    expect(splitQuoted("New answer\n\n> Old\n> More")).toEqual({ main: "New answer", quoted: "> Old\n> More" });
  });
  test("inline fresh answers are not stripped", () => {
    expect(splitQuoted("> Question\nMy answer\n> Another question\nAnother answer").main).toBe("> Question\nMy answer\n> Another question\nAnother answer");
  });
  test("quote-only and empty messages", () => {
    expect(splitQuoted("> All quoted")).toEqual({ main: "> All quoted", quoted: "" });
    expect(splitQuoted("")).toEqual({ main: "", quoted: "" });
  });
  test("line endings and ordinary prose", () => {
    expect(splitQuoted("New\r\n\r\nOn Wednesday, old@example.test wrote:\r\nOld").main).toBe("New");
    expect(splitQuoted("On Wednesday we discussed this.\nHere is my answer.").quoted).toBe("");
  });
});
