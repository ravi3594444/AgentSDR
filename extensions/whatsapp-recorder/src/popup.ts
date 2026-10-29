/**
 * The toolbar popup: where the browser assistant stands — the workspace it is
 * connected to, the website access the owner gave it, what it is doing now
 * and the last thing it did, a page that needs the owner — and the owner's
 * controls: Stop/Resume (Stop closes its tabs; nothing runs until Resume),
 * Share this tab (the assistant may read that page), Change website access
 * (the Connect page, without a pairing), Settings and Disconnect.
 *
 * It refreshes every second while open and updates text in place: buttons
 * are never rebuilt, so keyboard focus stays where it is, and the live
 * regions announce changes rather than every refresh.
 */

import type { BridgeResult, ResearchMessage, ResearchStatus } from "./messages";
import { accessLine, hostOf, lastLine, nowLine, popupState } from "./popupState";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const stateLine = $("state");
const facts = $("facts");
const attentionBox = $("attention");
const sharedBox = $("shared");
const sharedList = $("shared-list");
const errorLine = $("error");
const pauseButton = $<HTMLButtonElement>("pause");
const shareButton = $<HTMLButtonElement>("share");
const accessButton = $<HTMLButtonElement>("access-button");
const settingsButton = $<HTMLButtonElement>("settings");
const disconnectButton = $<HTMLButtonElement>("disconnect");

function ask<T>(message: ResearchMessage): Promise<T> {
  return chrome.runtime.sendMessage<ResearchMessage, T>(message);
}

/** Sets text only when it changed. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function show(element: HTMLElement, visible: boolean): void {
  if (element.hidden === visible) element.hidden = !visible;
}

function onClick(button: HTMLButtonElement, handler: () => Promise<unknown>): void {
  button.addEventListener("click", () => {
    errorLine.textContent = "";
    void handler().catch((error: unknown) => {
      errorLine.textContent = error instanceof Error ? error.message : String(error);
    });
  });
}

async function act(message: ResearchMessage): Promise<void> {
  const result = await ask<BridgeResult>(message);
  if (!result.ok) errorLine.textContent = result.error;
  await render();
}

/** The page the popup was opened on (activeTab lets the popup see its address). */
let current: { tabId: number; origin: string } | null = null;
let latest: ResearchStatus | null = null;
let sharedKey = "";

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

async function showAttentionPage(): Promise<void> {
  const tabId = latest?.attention?.tabId;
  if (tabId === undefined) return;
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

function renderShared(status: ResearchStatus): void {
  const key = JSON.stringify(status.sharedTabs);
  if (key === sharedKey) return;
  sharedKey = key;
  sharedList.replaceChildren(
    ...status.sharedTabs.map((tab) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = tab.title || tab.url;
      label.title = tab.url;
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "small";
      stop.textContent = "Stop sharing";
      stop.setAttribute("aria-label", `Stop sharing ${tab.title || hostOf(tab.url)}`);
      onClick(stop, () => act({ target: "research", type: "unshare-tab", tabId: tab.tabId }));
      item.append(label, stop);
      return item;
    }),
  );
  show(sharedBox, status.sharedTabs.length > 0);
}

async function render(): Promise<void> {
  const status = await ask<ResearchStatus>({ target: "research", type: "status" });
  latest = status;
  const now = Date.now();
  const state = popupState(status, now);
  setText(stateLine, state.label);
  const pillClass = `pill ${state.tone}`.trim();
  if (stateLine.className !== pillClass) stateLine.className = pillClass;
  setText($("state-detail"), state.detail);

  const connected = status.connected;
  show(facts, connected);
  for (const button of [pauseButton, shareButton, accessButton, disconnectButton]) show(button, connected);
  settingsButton.classList.toggle("wide", !connected);
  if (!connected) {
    show(attentionBox, false);
    show(sharedBox, false);
    sharedKey = "";
    return;
  }

  setText($("workspace"), status.organizationName ?? "Your workspace");
  setText($("account"), [status.userEmail, status.apiBase ? hostOf(status.apiBase) : null].filter(Boolean).join(" · "));
  setText($("access"), accessLine(status));
  setText($("now"), nowLine(status, now));
  setText($("last"), lastLine(status, now));

  show(attentionBox, Boolean(status.attention));
  if (status.attention) setText($("attention-detail"), `${status.attention.detail} (${hostOf(status.attention.url)}).`);

  setText(pauseButton, status.paused ? "Resume" : "Stop");
  renderShared(status);
}

onClick(pauseButton, () => act({ target: "research", type: "pause", paused: !latest?.paused }));
onClick(shareButton, shareCurrentTab);
onClick(accessButton, () => chrome.tabs.create({ url: chrome.runtime.getURL("connect.html") }));
onClick(settingsButton, () => chrome.runtime.openOptionsPage());
onClick(disconnectButton, () => act({ target: "research", type: "disconnect" }));
onClick($<HTMLButtonElement>("show-page"), showAttentionPage);
setText($("version"), `Version ${chrome.runtime.getManifest().version}`);

void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.id !== undefined && tab.url && /^https:\/\//i.test(tab.url)) current = { tabId: tab.id, origin: `https://${new URL(tab.url).hostname}/*` };
});
void render().catch((error: unknown) => {
  errorLine.textContent = error instanceof Error ? error.message : String(error);
});
setInterval(() => void render().catch(() => undefined), 1_000);
