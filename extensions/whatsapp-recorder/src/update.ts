/**
 * The Update page: installs the build an AgentSDR deployment serves
 * (/downloads/call-recorder) into the folder this unpacked extension was
 * loaded from, then reloads the extension. Chrome never updates an unpacked
 * extension itself, and unzipping by hand lands a renamed copy in Downloads
 * that Chrome is not loading.
 *
 * The folder is chosen once (File System Access) and remembered in
 * IndexedDB. It must be the very folder Chrome runs this extension from:
 * same manifest name and version, and a file written into it is served back
 * at this extension's own URL. Another copy of the same version (an older
 * download, the dev build) would pass the manifest check alone.
 * Opened by AgentSDR's Update button with ?from=<its origin>, or from Options.
 */

import { unzipSync } from "fflate";
import { allowedOrigins } from "./origins";

/** The zip's single top-level folder (extensions/whatsapp-recorder/package.ts). */
const ZIP_FOLDER = "agentsdr-call-recorder/";
const DOWNLOAD_PATH = "/downloads/call-recorder";

// File System Access members Chrome has and TypeScript's DOM lib lacks.
type PermissionMode = { mode: "readwrite" };
type FolderHandle = FileSystemDirectoryHandle & {
  queryPermission(options: PermissionMode): Promise<PermissionState>;
  requestPermission(options: PermissionMode): Promise<PermissionState>;
};
declare function showDirectoryPicker(options: PermissionMode & { id?: string }): Promise<FolderHandle>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const running = chrome.runtime.getManifest();

function setStatus(text: string, tone: "ok" | "error" | "" = ""): void {
  const status = $("status");
  status.textContent = text;
  status.className = tone;
}

// --- the remembered folder ----------------------------------------------------

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("recorder-updater", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savedFolder(): Promise<FolderHandle | null> {
  const db = await openStore();
  return new Promise((resolve) => {
    const request = db.transaction("handles").objectStore("handles").get("folder");
    request.onsuccess = () => resolve((request.result as FolderHandle | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

async function saveFolder(folder: FolderHandle): Promise<void> {
  const db = await openStore();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("handles", "readwrite");
    transaction.objectStore("handles").put(folder, "folder");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

const ANOTHER_COPY =
  "it is another copy, not the folder Chrome runs the extension from (chrome://extensions → Details → Source).";

/** Why `folder` is not the one Chrome loaded this extension from, or null if it is. Needs write access. */
async function notThisExtension(folder: FolderHandle): Promise<string | null> {
  let manifest: { name?: string; version?: string };
  try {
    const file = await (await folder.getFileHandle("manifest.json")).getFile();
    manifest = JSON.parse(await file.text()) as typeof manifest;
  } catch {
    return `"${folder.name}" has no manifest.json — choose the folder itself, not the one around it.`;
  }
  if (manifest.name !== running.name) return `"${folder.name}" holds a different extension.`;
  if (manifest.version !== running.version) {
    return `"${folder.name}" holds version ${manifest.version}, but Chrome is running ${running.version} — ${ANOTHER_COPY}`;
  }
  return (await servesFrom(folder)) ? null : `"${folder.name}" holds the same version, but ${ANOTHER_COPY}`;
}

/**
 * Whether Chrome serves this extension's files from `folder`: a file written
 * there must come back from chrome.runtime.getURL. An unpacked extension's
 * files are read from disk on each request.
 */
async function servesFrom(folder: FolderHandle): Promise<boolean> {
  const name = `update-check-${crypto.randomUUID()}.txt`;
  try {
    await writeFile(folder, name, new TextEncoder().encode(name));
    const response = await fetch(chrome.runtime.getURL(name), { cache: "no-store" });
    return response.ok && (await response.text()) === name;
  } catch {
    return false;
  } finally {
    await folder.removeEntry(name).catch(() => {});
  }
}

// --- the update ---------------------------------------------------------------

async function sourceOrigin(): Promise<string | null> {
  const from = new URLSearchParams(location.search).get("from");
  const origins = await allowedOrigins();
  if (from && origins.includes(from)) return from;
  return origins[0] ?? null;
}

/** The deployment's build as files keyed by their path inside the extension. */
async function download(origin: string): Promise<Map<string, Uint8Array>> {
  const response = await fetch(`${origin}${DOWNLOAD_PATH}`, { credentials: "include", cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.includes("zip")) {
    throw new Error(
      response.redirected || response.headers.get("content-type")?.includes("html")
        ? `Sign in to 22nd x ai at ${origin} in this browser, then try again.`
        : `${origin} answered ${response.status} — it may not serve the extension yet.`,
    );
  }
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith(ZIP_FOLDER) || path.endsWith("/")) continue;
    const inner = path.slice(ZIP_FOLDER.length);
    if (inner.split("/").some((part) => part === ".." || part === "")) continue;
    files.set(inner, bytes);
  }
  if (!files.has("manifest.json")) throw new Error("The download is not this extension (no manifest.json).");
  return files;
}

async function writeFile(folder: FileSystemDirectoryHandle, path: string, bytes: Uint8Array): Promise<void> {
  const parts = path.split("/");
  let directory = folder;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const writable = await (await directory.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await writable.write(bytes as Uint8Array<ArrayBuffer>);
  await writable.close();
}

async function update(): Promise<void> {
  const button = $<HTMLButtonElement>("update");
  button.disabled = true;
  try {
    const folder = await savedFolder();
    if (!folder) return setStatus("Choose the extension's folder first.", "error");
    // Asked inside the click: Chrome may show its own "allow edits" prompt.
    if ((await folder.requestPermission({ mode: "readwrite" })) !== "granted") {
      return setStatus("Chrome was not allowed to change the folder, so nothing was updated.", "error");
    }
    const problem = await notThisExtension(folder);
    if (problem) return setStatus(`${problem} Choose the folder again.`, "error");

    const origin = await sourceOrigin();
    if (!origin) return setStatus("No 22nd x ai address is allowed — add one in Settings.", "error");
    setStatus(`Downloading from ${origin}…`);
    const files = await download(origin);
    const next = (JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as { version?: string }).version;

    setStatus(`Installing ${next}…`);
    // The manifest last: until it is written, Chrome still sees the old version.
    for (const [path, bytes] of files) if (path !== "manifest.json") await writeFile(folder, path, bytes);
    await writeFile(folder, "manifest.json", files.get("manifest.json")!);

    setStatus(`Updated to ${next}. Reloading the extension — reload WhatsApp Web before your next call.`, "ok");
    setTimeout(() => chrome.runtime.reload(), 1_200);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function chooseFolder(): Promise<void> {
  let folder: FolderHandle;
  try {
    folder = await showDirectoryPicker({ id: "agentsdr-call-recorder", mode: "readwrite" });
  } catch {
    return; // closed the picker
  }
  const problem = await notThisExtension(folder);
  if (problem) return setStatus(problem, "error");
  await saveFolder(folder);
  setStatus(`Using "${folder.name}". Updates are written there from now on.`, "ok");
  await render();
}

async function render(): Promise<void> {
  $("version").textContent = running.version;
  const folder = await savedFolder();
  $("folder").textContent = folder ? folder.name : "Not chosen yet";
  $("choose").textContent = folder ? "Change folder" : "Choose folder";
  $<HTMLButtonElement>("update").disabled = !folder;
  $("source").textContent = (await sourceOrigin()) ?? "none";
}

$("choose").addEventListener("click", () => void chooseFolder());
$("update").addEventListener("click", () => void update());
void render();
