/**
 * The extension's Settings page (Chrome's "Extension options"): the browser
 * assistant's connection and website access, what happens to screenshots,
 * the 22nd x ai addresses the extension serves, and calls and recording.
 *
 * Adding an address (someone running their own deployment) asks Chrome for
 * access to that site (optional_host_permissions) and stores it;
 * background.ts then injects the bridge there. Removing one gives the
 * permission back. The storage key and the bridge are the same as before the
 * page was renamed from "Call recorder options", so saved addresses stay.
 */
import { SCREENSHOT_NOTE } from "../../../src/lib/browser/screenshotNote";
import type { ResearchMessage, ResearchStatus } from "./messages";
import { BUILT_IN_ORIGINS, customOrigins, normalizeOrigin, originPattern, saveCustomOrigins } from "./origins";
import { accessLine, hostOf, popupState } from "./popupState";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function setStatus(text: string, tone: "ok" | "error" | "" = ""): void {
  const status = $("status");
  status.textContent = text;
  status.className = tone;
}

function row(origin: string, removable: boolean): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = origin;
  li.append(label);
  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${origin}`);
    remove.addEventListener("click", () => void removeOrigin(origin));
    li.append(remove);
  } else {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "built in";
    li.append(tag);
  }
  return li;
}

async function render(): Promise<void> {
  const custom = await customOrigins();
  $("custom").replaceChildren(...custom.map((origin) => row(origin, true)));
  $("none").hidden = custom.length > 0;
  $("builtin").replaceChildren(...BUILT_IN_ORIGINS.map((origin) => row(origin, false)));
}

/** Sets text only when it changed, so the live region announces changes, not every refresh. */
function setText(id: string, text: string): void {
  const element = $(id);
  if (element.textContent !== text) element.textContent = text;
}

async function renderAssistant(): Promise<void> {
  const status = await chrome.runtime.sendMessage<ResearchMessage, ResearchStatus>({ target: "research", type: "status" });
  const state = popupState(status, Date.now());
  const where = [status.organizationName, status.userEmail, status.apiBase ? hostOf(status.apiBase) : null].filter(Boolean).join(" · ");
  setText("assistant-state", state.detail ? `${state.label}. ${state.detail}` : state.label);
  setText("assistant-workspace", status.connected ? where : "—");
  setText("assistant-access", status.connected ? accessLine(status) : "Chosen when you connect");
  $("change-access").hidden = !status.connected;
}

async function addOrigin(input: string): Promise<void> {
  const origin = normalizeOrigin(input);
  if (!origin) {
    setStatus("That is not a 22nd x ai address. Use https://, for example https://sdr.yourcompany.com.", "error");
    return;
  }
  if (BUILT_IN_ORIGINS.includes(origin) || (await customOrigins()).includes(origin)) {
    setStatus(`${origin} is already allowed.`, "ok");
    return;
  }
  // Must run in the click's user gesture: Chrome shows its own prompt.
  const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
  if (!granted) {
    setStatus(`Chrome did not allow access to ${origin}, so it was not added.`, "error");
    return;
  }
  await saveCustomOrigins([...(await customOrigins()), origin]);
  setStatus(`Added ${origin}. Reload any open 22nd x ai tab there.`, "ok");
  ($("origin") as HTMLInputElement).value = "";
  await render();
}

async function removeOrigin(origin: string): Promise<void> {
  await saveCustomOrigins((await customOrigins()).filter((value) => value !== origin));
  await chrome.permissions.remove({ origins: [originPattern(origin)] }).catch(() => false);
  setStatus(`Removed ${origin}.`, "ok");
  await render();
}

$("add").addEventListener("submit", (event) => {
  event.preventDefault();
  void addOrigin(($("origin") as HTMLInputElement).value);
});
$("change-access").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("connect.html") });
});
$("version").textContent = `version ${chrome.runtime.getManifest().version}`;
$("screenshot-note").textContent = SCREENSHOT_NOTE;

void render();
void renderAssistant().catch(() => {
  setText("assistant-state", "Could not read the connection. Reload this page.");
});
setInterval(() => void renderAssistant().catch(() => undefined), 5_000);
