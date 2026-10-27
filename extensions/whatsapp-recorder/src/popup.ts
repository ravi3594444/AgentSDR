/**
 * The toolbar popup: where connected-browser research stands, and the
 * owner's controls over it — Stop (closes its tabs; nothing runs until
 * Resume), Share this tab (the assistant may read that page), the sites,
 * and Disconnect.
 */

import { RESEARCH_SITES } from "../../../src/lib/browser/connected/contract";
import type { BridgeResult, ResearchMessage, ResearchStatus } from "./messages";

const stateLine = document.getElementById("state")!;
const detail = document.getElementById("detail")!;
const sharedList = document.getElementById("shared")!;
const actions = document.getElementById("actions")!;
const errorLine = document.getElementById("error")!;

function ask<T>(message: ResearchMessage): Promise<T> {
  return chrome.runtime.sendMessage<ResearchMessage, T>(message);
}

function button(label: string, onClick: () => Promise<void>, primary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (primary) element.className = "primary";
  element.addEventListener("click", () => {
    errorLine.textContent = "";
    void onClick().catch((error: unknown) => {
      errorLine.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  return element;
}

async function act(message: ResearchMessage): Promise<void> {
  const result = await ask<BridgeResult>(message);
  if (!result.ok) errorLine.textContent = result.error;
  await render();
}

/** The page the popup was opened on (activeTab lets the popup see its address). */
let current: { tabId: number; origin: string } | null = null;

async function shareCurrentTab(): Promise<void> {
  if (!current) {
    errorLine.textContent = "Open the https page you want to share, then press Share this tab.";
    return;
  }
  // Called first, on the click itself: Chrome asks only on a user gesture (and answers at once when already allowed).
  if (!(await chrome.permissions.request({ origins: [current.origin] }))) {
    errorLine.textContent = "Chrome's permission for that site is needed to share it.";
    return;
  }
  await act({ target: "research", type: "share-tab", tabId: current.tabId });
}

async function render(): Promise<void> {
  const status = await ask<ResearchStatus>({ target: "research", type: "status" });
  actions.replaceChildren();
  sharedList.replaceChildren();
  if (!status.connected) {
    stateLine.textContent = "Not connected";
    stateLine.className = "";
    detail.textContent = "Press Connect browser in AgentSDR's chat to let the assistant research in this browser.";
    return;
  }
  const sites = status.sites.map((key) => RESEARCH_SITES[key].label).join(", ");
  stateLine.textContent = status.paused ? "Stopped" : status.attention ? "Needs you" : status.busy ? "Researching now" : "Connected";
  stateLine.className = status.paused || status.attention ? "warn" : "ok";
  detail.textContent = status.attention
    ? `${status.attention.detail} (${new URL(status.attention.url || "https://unknown").hostname}). Open the AgentSDR research tab group to deal with it.`
    : `${status.organizationName ?? ""}${status.userEmail ? ` · ${status.userEmail}` : ""} · ${sites || "no sites"} · ${status.openTabs} research tab${status.openTabs === 1 ? "" : "s"} open${status.lastError ? ` · last problem: ${status.lastError}` : ""}`;
  for (const tab of status.sharedTabs) {
    const item = document.createElement("li");
    item.textContent = `Shared: ${tab.title || tab.url} `;
    item.append(button("Stop sharing", () => act({ target: "research", type: "unshare-tab", tabId: tab.tabId })));
    sharedList.append(item);
  }
  actions.append(
    status.paused
      ? button("Resume", () => act({ target: "research", type: "pause", paused: false }), true)
      : button("Stop", () => act({ target: "research", type: "pause", paused: true }), true),
    button("Share this tab", shareCurrentTab),
    button("Sites", async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL("connect.html") });
    }),
    button("Disconnect", () => act({ target: "research", type: "disconnect" })),
  );
}

void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.id !== undefined && tab.url && /^https:\/\//i.test(tab.url)) current = { tabId: tab.id, origin: `https://${new URL(tab.url).hostname}/*` };
});
void render();
