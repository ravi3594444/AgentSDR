import "server-only";

import { verifyAiCredentials } from "@/lib/ai/server/verify";
import { verifyAnthropicKey } from "@/lib/ai/server/anthropicRuntime";
import { normalizeUnipileCredentials } from "@/lib/platform/credentials";
import { verifyPlatformCredentials } from "@/lib/platform/verify";
import { ApifyError, verifyApifyToken } from "@/services/apify";
import { BrightdataError, verifyBrightdataKey } from "@/services/brightdata";
import { getTavilyUsage, TavilyError } from "@/services/tavily";
import { TinyfishError, tinyfishSearch } from "@/services/tinyfish";
import type { PlatformCredentialKey } from "./catalog";

/**
 * One cheap authenticated call per provider before the platform's credential
 * is stored, so a typo fails in the operator panel rather than in every
 * Included workspace. The same checks a workspace's own key goes through,
 * except TinyFish: its own check reserves the search in the organization's
 * ledger, which a platform key has none of, so it is one plain search here
 * (one request of the key's free allowance). Throws an Error whose message
 * is safe to show; returns normalized values to store when it changes any.
 */
export async function verifyPlatformCredential(key: PlatformCredentialKey, values: Record<string, string>): Promise<Record<string, string> | void> {
  switch (key) {
    case "unipile": {
      const normalized = normalizeUnipileCredentials(values);
      await verifyPlatformCredentials("unipile", normalized);
      return { ...values, ...normalized };
    }
    case "openrouter":
      await verifyAiCredentials("openrouter", { apiKey: values.apiKey ?? "", managementKey: values.managementKey ?? "" });
      return;
    case "aimlapi":
      await verifyAiCredentials("aimlapi", { apiKey: values.apiKey ?? "" });
      return;
    case "anthropic":
      await verifyAnthropicKey(values.apiKey ?? "");
      return;
    case "tinyfish":
      try {
        await tinyfishSearch(values.apiKey ?? "", { query: "tinyfish web search" });
      } catch (error) {
        if (error instanceof TinyfishError && (error.status === 401 || error.status === 403)) throw new Error("TinyFish rejected this key.");
        // A busy or rate-limited key is still a real key.
        if (error instanceof TinyfishError && (error.status === 429 || error.status === 402)) return;
        throw new Error(`The key could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    case "tavily":
      try {
        await getTavilyUsage(values.apiKey ?? "");
      } catch (error) {
        throw new Error(error instanceof TavilyError && (error.status === 401 || error.status === 403) ? "Tavily rejected this key." : `The key could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    case "brightdata":
      try {
        await verifyBrightdataKey(values.apiKey ?? "");
      } catch (error) {
        throw new Error(error instanceof BrightdataError && (error.status === 401 || error.status === 403) ? "Bright Data rejected this key." : `The key could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    case "apify":
      try {
        await verifyApifyToken(values.apiKey ?? "");
      } catch (error) {
        throw new Error(error instanceof ApifyError && (error.status === 401 || error.status === 403) ? "Apify rejected this token." : `The token could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
  }
}
