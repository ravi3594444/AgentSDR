/**
 * The Connect page (connect.html): opened by the app's Connect browser with
 * a one-time pairing, or from the toolbar to change website access. The
 * owner chooses "Allow all websites" or "Choose specific websites" (the
 * social sites they tick and websites by domain); Chrome is asked for that
 * access here, on the owner's click, once; then the service worker pairs
 * with the app (research.ts). Website access is only where the assistant
 * may go: what it does there is what the owner asks in the chat.
 */

import { accessDomains, accessModeOf, accessOrigins, RESEARCH_SITE_KEYS, RESEARCH_SITES, type ResearchSiteKey } from "../../../src/lib/browser/connected/contract";
import type { BridgeResult, ResearchMessage, ResearchPairing } from "./messages";

const NOTES: Record<ResearchSiteKey, string> = {
  web: "Company websites, directories, your CRM and other public pages (not the social sites below).",
  linkedin: "Profiles, company pages, messages and LinkedIn search, as you see them.",
  x: "Profiles, posts, messages and X search.",
  reddit: "Posts, comments and Reddit search. Authors are pseudonymous: never treated as leads unless their profile publishes a contact.",
  instagram: "Profiles, posts and messages.",
  facebook: "Pages, posts, groups and messages you can see.",
};

const nonce = new URLSearchParams(location.search).get("pairing");
const sitesBox = document.getElementById("sites")!;
const domainsBox = document.getElementById("domains") as HTMLTextAreaElement;
const selectedPanel = document.getElementById("selected-panel")!;
const button = document.getElementById("connect") as HTMLButtonElement;
const statusLine = document.getElementById("status")!;
const allOption = document.getElementById("access-all") as HTMLInputElement;
const selectedOption = document.getElementById("access-selected") as HTMLInputElement;

function say(text: string, kind: "error" | "ok" | "" = ""): void {
  statusLine.textContent = text;
  statusLine.className = kind;
}

function ask<T>(message: ResearchMessage): Promise<T> {
  return chrome.runtime.sendMessage<ResearchMessage, T>(message);
}

/** What the owner chose: every site key for all websites, else the ticked ones and the listed websites. */
function chosen(): { sites: ResearchSiteKey[]; domains: string[]; rejected: string[] } {
  if (allOption.checked) return { sites: [...RESEARCH_SITE_KEYS], domains: [], rejected: [] };
  const sites = RESEARCH_SITE_KEYS.filter((key) => (document.getElementById(`site-${key}`) as HTMLInputElement | null)?.checked);
  const typed = domainsBox.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  const domains = accessDomains(typed);
  const rejected = typed.filter((item) => !accessDomains([item]).length);
  return { sites, domains, rejected };
}

function showMode(): void {
  selectedPanel.hidden = !selectedOption.checked;
}

function render(pairing: ResearchPairing): void {
  document.getElementById("app")!.textContent = pairing.apiBase;
  if (pairing.connected) {
    document.getElementById("heading")!.textContent = "Website access for this browser";
    button.textContent = "Save";
  }
  const mode = accessModeOf(pairing.sites);
  allOption.checked = mode === "all";
  selectedOption.checked = mode === "selected";
  for (const key of RESEARCH_SITE_KEYS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `site-${key}`;
    box.checked = mode === "selected" && pairing.sites.includes(key);
    const text = document.createElement("span");
    text.textContent = RESEARCH_SITES[key].label;
    const small = document.createElement("small");
    small.textContent = NOTES[key];
    text.append(small);
    label.append(box, text);
    sitesBox.append(label);
  }
  domainsBox.value = pairing.domains.join("\n");
  allOption.addEventListener("change", showMode);
  selectedOption.addEventListener("change", showMode);
  showMode();
}

async function submit(pairing: ResearchPairing): Promise<void> {
  const { sites, domains, rejected } = chosen();
  if (rejected.length) {
    say(`Not a public website: ${rejected.join(", ")}. Write each as its address, for example app.hubspot.com.`, "error");
    return;
  }
  if (!sites.length && !domains.length) {
    say("Choose at least one website, or allow all websites.", "error");
    return;
  }
  button.disabled = true;
  say("Waiting for Chrome's permission…");
  try {
    // Must run straight from the click: Chrome only asks on a user gesture, and asks once for all of it.
    const granted = await chrome.permissions.request({ origins: accessOrigins(sites, domains) });
    if (!granted) {
      say("Chrome's permission is needed for the websites you chose. Nothing was changed.", "error");
      return;
    }
    say(pairing.connected ? "Saving…" : "Connecting…");
    const result = nonce && !pairing.connected
      ? await ask<BridgeResult & { organizationName?: string }>({ target: "research", type: "pair", nonce, sites, domains })
      : await ask<BridgeResult>({ target: "research", type: "set-sites", sites, domains });
    if (!result.ok) {
      say(result.error, "error");
      return;
    }
    const organization = "organizationName" in result && result.organizationName ? ` to ${result.organizationName}` : "";
    say(pairing.connected ? "Saved." : `Connected${organization}. You can close this tab; the assistant can now work in this browser when you ask it to.`, "ok");
    button.textContent = "Done";
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
  }
}

void ask<ResearchPairing | null>({ target: "research", type: "pairing", nonce }).then((pairing) => {
  if (!pairing) {
    say("This connect link expired. Press Connect browser in the app again.", "error");
    button.disabled = true;
    return;
  }
  render(pairing);
  button.addEventListener("click", () => void submit(pairing));
});
