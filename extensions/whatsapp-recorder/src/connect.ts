/**
 * The Connect page (connect.html): opened by the app's Connect browser with
 * a one-time pairing, or from the toolbar to change the enabled sites. The
 * site permissions Chrome requires are asked for here, on the owner's click,
 * once; then the service worker pairs with the app (research.ts).
 */

import { RESEARCH_SITE_KEYS, RESEARCH_SITES, type ResearchSiteKey } from "../../../src/lib/browser/connected/contract";
import type { BridgeResult, ResearchMessage, ResearchPairing } from "./messages";

const NOTES: Record<ResearchSiteKey, string> = {
  web: "Company websites, directories and other public pages (not the social sites below).",
  linkedin: "Profiles, company pages and LinkedIn search, as you see them.",
  x: "Profiles, posts and X search.",
  reddit: "Posts, comments and Reddit search. Authors are pseudonymous: never treated as leads unless their profile publishes a contact.",
  instagram: "Public profiles and posts.",
  facebook: "Pages, public posts and groups you can see.",
};

const nonce = new URLSearchParams(location.search).get("pairing");
const sitesBox = document.getElementById("sites")!;
const button = document.getElementById("connect") as HTMLButtonElement;
const statusLine = document.getElementById("status")!;

function say(text: string, kind: "error" | "ok" | "" = ""): void {
  statusLine.textContent = text;
  statusLine.className = kind;
}

function ask<T>(message: ResearchMessage): Promise<T> {
  return chrome.runtime.sendMessage<ResearchMessage, T>(message);
}

function chosen(): ResearchSiteKey[] {
  return RESEARCH_SITE_KEYS.filter((key) => (document.getElementById(`site-${key}`) as HTMLInputElement | null)?.checked);
}

function render(pairing: ResearchPairing): void {
  document.getElementById("app")!.textContent = pairing.apiBase;
  if (pairing.connected) {
    document.getElementById("heading")!.textContent = "Research sites in this browser";
    button.textContent = "Save sites";
  }
  for (const key of RESEARCH_SITE_KEYS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `site-${key}`;
    box.checked = pairing.sites.includes(key);
    const text = document.createElement("span");
    text.textContent = RESEARCH_SITES[key].label;
    const small = document.createElement("small");
    small.textContent = NOTES[key];
    text.append(small);
    label.append(box, text);
    sitesBox.append(label);
  }
}

async function submit(pairing: ResearchPairing): Promise<void> {
  const sites = chosen();
  if (!sites.length) {
    say("Choose at least one kind of site.", "error");
    return;
  }
  button.disabled = true;
  say("Waiting for Chrome's permission…");
  try {
    // Must run straight from the click: Chrome only asks on a user gesture.
    const granted = await chrome.permissions.request({ origins: sites.flatMap((key) => [...RESEARCH_SITES[key].origins]) });
    if (!granted) {
      say("Chrome's permission is needed for the sites you chose. Nothing was connected.", "error");
      return;
    }
    say(pairing.connected ? "Saving…" : "Connecting…");
    const result = nonce && !pairing.connected
      ? await ask<BridgeResult & { organizationName?: string }>({ target: "research", type: "pair", nonce, sites })
      : await ask<BridgeResult>({ target: "research", type: "set-sites", sites });
    if (!result.ok) {
      say(result.error, "error");
      return;
    }
    const organization = "organizationName" in result && result.organizationName ? ` to ${result.organizationName}` : "";
    say(pairing.connected ? "Saved." : `Connected${organization}. You can close this tab; the assistant can now research in this browser.`, "ok");
    button.textContent = "Done";
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
  }
}

void ask<ResearchPairing | null>({ target: "research", type: "pairing", nonce }).then((pairing) => {
  if (!pairing) {
    say("This connect link expired. Press Connect browser in AgentSDR again.", "error");
    button.disabled = true;
    return;
  }
  render(pairing);
  button.addEventListener("click", () => void submit(pairing));
});
