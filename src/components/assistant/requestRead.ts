/** A deadline for reading saved UI state; this does not limit background research. */
export const REQUEST_READ_TIMEOUT_MS = 20_000;

export async function readRequestJson<T>(url: string, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const body: unknown = await response.json().catch(() => { throw new Error("The server returned an unreadable response. Try again."); });
        if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Request failed (HTTP ${response.status})`);
        return parse(body);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Loading took too long. Try again to read the latest saved status; background work has not been stopped."));
          controller.abort();
        }, REQUEST_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
