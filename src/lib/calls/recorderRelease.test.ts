import { describe, expect, test } from "bun:test";
import manifest from "../../../extensions/whatsapp-recorder/static/manifest.json";
import { BUILT_IN_ORIGINS } from "../../../extensions/whatsapp-recorder/src/origins";
import { BRAND } from "@/lib/brand";
import { extensionNotDetected, RECORDER_BUILT_IN_ORIGINS, RECORDER_EXTENSION_NAME } from "./recorderRelease";

describe("the extension's identity", () => {
  test("Chrome, the toolbar and the app call it the brand's Browser Assistant", () => {
    expect(RECORDER_EXTENSION_NAME).toBe(`${BRAND.shortName} Browser Assistant`);
    expect(manifest.action.default_title).toBe(RECORDER_EXTENSION_NAME);
    // The Chrome Web Store's limit, and what chrome://extensions shows without cutting it.
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  test("the app knows the same built-in addresses as the extension", () => {
    expect([...RECORDER_BUILT_IN_ORIGINS]).toEqual([...BUILT_IN_ORIGINS]);
  });
});

describe("extensionNotDetected", () => {
  test("never says the extension is not installed", () => {
    for (const origin of ["https://app.agentsdr.ai", "https://sdr.yourcompany.com"]) {
      const help = extensionNotDetected(origin);
      expect(help.title).toBe("Extension not detected on this site");
      expect(`${help.title} ${help.intro} ${help.steps.join(" ")}`).not.toMatch(/not installed|uninstalled|isn't installed/i);
    }
  });

  test("a self-hosted address is told to add itself on the extension's Settings page", () => {
    const help = extensionNotDetected("https://sdr.yourcompany.com");
    expect(help.builtIn).toBe(false);
    expect(help.steps.join(" ")).toContain("Settings");
    expect(help.steps.join(" ")).toContain("add https://sdr.yourcompany.com");
    expect(help.steps.at(-1)).toBe("Reload this page.");
  });

  test("a built-in address needs no access step", () => {
    const help = extensionNotDetected("https://app.agentsdr.ai");
    expect(help.builtIn).toBe(true);
    expect(help.steps.join(" ")).not.toContain("add https://");
  });
});
