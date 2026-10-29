/**
 * The browser extension this deployment serves (the 22nd x ai Browser
 * Assistant, which also places and records calls). The zip at
 * RECORDER_DOWNLOAD_PATH is built from the same source in `bun run build`,
 * so its version and name are always these. Client-safe.
 */

import manifest from "../../../extensions/whatsapp-recorder/static/manifest.json";

export const LATEST_RECORDER_VERSION: string = manifest.version;

export const RECORDER_DOWNLOAD_PATH = "/downloads/call-recorder";

/** The first extension version with its own Update page (the `recorder:update` bridge request). */
export const RECORDER_SELF_UPDATE_VERSION = "0.14.0";

/** Where the download and the install / update steps are shown. */
export const RECORDER_SETUP_PATH = "/settings/whatsapp-connection";

/** The extension's name as Chrome and its toolbar show it. */
export const RECORDER_EXTENSION_NAME: string = manifest.name;

/**
 * The app addresses the extension serves without being told: the pages its
 * bridge content script matches (extensions/whatsapp-recorder/src/origins.ts
 * keeps the same list). Any other address, a self-hosted deployment, must be
 * added on the extension's Settings page before the extension can see it.
 */
export const RECORDER_BUILT_IN_ORIGINS: readonly string[] = manifest.content_scripts
  .filter((script) => script.js.includes("bridge.js"))
  .flatMap((script) => script.matches.map((pattern) => pattern.replace(/\/\*$/, "")));

/**
 * What to tell someone when this page carries no mark from the extension.
 * The app cannot tell "not installed" from "installed but not allowed on this
 * address" (the extension never runs here in either case), so it never says
 * the extension is missing: it says it is not detected on this site and how
 * to give it access here. Callers add how to install it.
 */
export function extensionNotDetected(origin: string): { title: string; intro: string; steps: string[]; builtIn: boolean } {
  const title = "Extension not detected on this site";
  if (RECORDER_BUILT_IN_ORIGINS.includes(origin)) {
    return {
      title,
      builtIn: true,
      intro: `The ${RECORDER_EXTENSION_NAME} extension did not answer on this page.`,
      steps: ["If it is installed, check that it is turned on in chrome://extensions.", "Reload this page."],
    };
  }
  return {
    title,
    builtIn: false,
    intro: `The ${RECORDER_EXTENSION_NAME} extension only works on the addresses it has been given, and ${origin} is not one of its built-in ones.`,
    steps: [
      "Open the extension's Settings: click its toolbar button (or Chrome's puzzle-piece menu), then Settings.",
      `Under 22nd x ai addresses, add ${origin} and allow access when Chrome asks.`,
      "Reload this page.",
    ],
  };
}

/** True when dotted version `a` is older than `b` ("0.9.0" < "0.13.1"). */
export function isOlderVersion(a: string, b: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}
