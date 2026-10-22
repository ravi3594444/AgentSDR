/**
 * Included services: what the platform supplies to every workspace on its
 * own credentials, and what a workspace may instead run on its own
 * ("My own provider"). Client-safe: the settings pages and the operator panel
 * import it. Credentials are resolved in store.server.ts / modes.server.ts.
 *
 * Google Workspace (the Gmail service account) and Cloudflare R2 are not
 * here: they stay the workspace's own (src/lib/platform/catalog.ts).
 */

/** A provider a workspace can take as an Included service or run on its own credentials. */
export type ManagedService = "ai" | "unipile" | "tinyfish" | "tavily" | "brightdata" | "apify";

export const MANAGED_SERVICES: readonly ManagedService[] = ["ai", "unipile", "tinyfish", "tavily", "brightdata", "apify"];

export function isManagedService(value: unknown): value is ManagedService {
  return typeof value === "string" && (MANAGED_SERVICES as readonly string[]).includes(value);
}

/** Included service (the platform's credentials) or My own provider (the workspace's). */
export type ServiceMode = "managed" | "own";

export const SERVICE_MODE_LABEL: Record<ServiceMode, string> = {
  managed: "Included service",
  own: "My own provider",
};

/** One stored platform credential. AI has three: the operator picks which engine Included workspaces use. */
export type PlatformCredentialKey = "unipile" | "openrouter" | "aimlapi" | "anthropic" | "tinyfish" | "tavily" | "brightdata" | "apify";

export const PLATFORM_CREDENTIAL_KEYS: readonly PlatformCredentialKey[] = ["unipile", "openrouter", "aimlapi", "anthropic", "tinyfish", "tavily", "brightdata", "apify"];

export function isPlatformCredentialKey(value: unknown): value is PlatformCredentialKey {
  return typeof value === "string" && (PLATFORM_CREDENTIAL_KEYS as readonly string[]).includes(value);
}

export type ManagedServiceInfo = {
  label: string;
  /** What it does for the workspace, in plain words. */
  description: string;
  /** Where a workspace on My own provider saves its own credentials. */
  ownSettingsHref: string;
  ownSettingsLabel: string;
  credentialKeys: PlatformCredentialKey[];
};

export const MANAGED_SERVICE_INFO: Record<ManagedService, ManagedServiceInfo> = {
  ai: {
    label: "AI",
    description: "Writes messages, sorts replies, judges leads and runs the assistant.",
    ownSettingsHref: "/settings/ai",
    ownSettingsLabel: "AI provider",
    credentialKeys: ["openrouter", "aimlapi", "anthropic"],
  },
  unipile: {
    label: "Account connections (Unipile)",
    description: "Connects LinkedIn, WhatsApp, Instagram and email accounts for sending and replies.",
    ownSettingsHref: "/settings/linkedin-connection",
    ownSettingsLabel: "Unipile connection",
    credentialKeys: ["unipile"],
  },
  tinyfish: {
    label: "Web search and page reading (TinyFish)",
    description: "Searches the web and reads public pages while researching leads.",
    ownSettingsHref: "/settings/research",
    ownSettingsLabel: "Lead research → TinyFish",
    credentialKeys: ["tinyfish"],
  },
  tavily: {
    label: "Website search (Tavily)",
    description: "Finds business websites and directories for a request.",
    ownSettingsHref: "/settings/advanced",
    ownSettingsLabel: "Providers & features → Tavily",
    credentialKeys: ["tavily"],
  },
  brightdata: {
    label: "Social research (Bright Data)",
    description: "Reads public Reddit, X, Instagram and Facebook posts and profiles.",
    ownSettingsHref: "/settings/advanced",
    ownSettingsLabel: "Providers & features → Bright Data",
    credentialKeys: ["brightdata"],
  },
  apify: {
    label: "Maps and Instagram discovery (Apify)",
    description: "Finds businesses on Google Maps and Instagram.",
    ownSettingsHref: "/settings/advanced",
    ownSettingsLabel: "Providers & features → Apify",
    credentialKeys: ["apify"],
  },
};

export type PlatformCredentialField = {
  key: string;
  label: string;
  /** Secret values never leave the server; a blank secret on replace keeps the stored one. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
};

export type PlatformCredentialInfo = {
  label: string;
  service: ManagedService;
  fields: PlatformCredentialField[];
  docsUrl: string;
};

export const PLATFORM_CREDENTIAL_INFO: Record<PlatformCredentialKey, PlatformCredentialInfo> = {
  unipile: {
    label: "Unipile",
    service: "unipile",
    docsUrl: "https://developer.unipile.com/docs/getting-started",
    fields: [
      { key: "baseUrl", label: "DSN (API address)", secret: false, required: true, placeholder: "api8.unipile.com:13851" },
      { key: "apiKey", label: "Access token", secret: true, required: true },
      { key: "notifySecret", label: "Webhook secret", secret: true, required: false, help: "Leave empty: one is generated and the platform's webhooks are registered with it." },
    ],
  },
  openrouter: {
    label: "OpenRouter",
    service: "ai",
    docsUrl: "https://openrouter.ai/docs",
    fields: [
      { key: "apiKey", label: "Inference API key", secret: true, required: true, placeholder: "sk-or-v1-…" },
      { key: "managementKey", label: "Management key", secret: true, required: true, placeholder: "sk-or-v1-…" },
    ],
  },
  aimlapi: {
    label: "AI/ML API",
    service: "ai",
    docsUrl: "https://docs.aimlapi.com",
    fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
  },
  anthropic: {
    label: "Anthropic (Claude API)",
    service: "ai",
    docsUrl: "https://platform.claude.com/docs",
    fields: [{ key: "apiKey", label: "Claude Developer Platform API key", secret: true, required: true, placeholder: "sk-ant-…" }],
  },
  tinyfish: {
    label: "TinyFish",
    service: "tinyfish",
    docsUrl: "https://docs.tinyfish.ai",
    fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
  },
  tavily: {
    label: "Tavily",
    service: "tavily",
    docsUrl: "https://docs.tavily.com",
    fields: [{ key: "apiKey", label: "API key", secret: true, required: true, placeholder: "tvly-…" }],
  },
  brightdata: {
    label: "Bright Data",
    service: "brightdata",
    docsUrl: "https://docs.brightdata.com",
    fields: [
      { key: "apiKey", label: "API key", secret: true, required: true },
      { key: "serpZone", label: "SERP API zone", secret: false, required: false, help: "Optional: a SERP zone in the platform's Bright Data account, used when no web search is set up." },
    ],
  },
  apify: {
    label: "Apify",
    service: "apify",
    docsUrl: "https://docs.apify.com/api/v2",
    fields: [{ key: "apiKey", label: "API token", secret: true, required: true, placeholder: "apify_api_…" }],
  },
};

/** What the operator panel shows about one stored credential: never a secret, only a masked hint. */
export type PlatformCredentialStatus = {
  key: PlatformCredentialKey;
  stored: boolean;
  /** Non-secret field values (a DSN, a SERP zone). */
  values: Record<string, string>;
  /** Masked secret hints, e.g. "…a1b2". */
  hints: Record<string, string>;
  verifiedAt: string | null;
  updatedAt: string | null;
  /** The organization an operator explicitly adopted it from, when it was copied rather than typed in. */
  adoptedFrom: { organizationId: string; name: string | null } | null;
};

/** The AI engines an Included workspace can run on. The Claude Code subscription login is not one: it is an owner-only pilot. */
export type ManagedAiEngine = "openrouter" | "aimlapi" | "anthropic";

export const MANAGED_AI_ENGINES: readonly ManagedAiEngine[] = ["openrouter", "aimlapi", "anthropic"];

export const MANAGED_AI_ENGINE_LABEL: Record<ManagedAiEngine, string> = {
  openrouter: "OpenRouter",
  aimlapi: "AI/ML API",
  anthropic: "Anthropic (Claude API)",
};

/** Claude models offered for the Anthropic engine; ids are complete as written. */
export const ANTHROPIC_MODELS: readonly { id: string; label: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];

export type ModelSelection = { provider: string; modelId: string };

/**
 * The Included AI engine and its models, chosen by the operator. Only the
 * operator panel reads it back; customers never see it.
 */
export type ManagedAiSettings = {
  engine: ManagedAiEngine | null;
  /** OpenRouter: the pinned upstream provider and its model; AI/ML API: provider "aimlapi"; Anthropic: provider "anthropic". */
  defaultModel: ModelSelection | null;
  /** AI/ML API only: a search model (e.g. Perplexity Sonar) for web research. */
  researchModel: ModelSelection | null;
  /** OpenRouter only: a model that transcribes call recordings. */
  transcriptionModel: ModelSelection | null;
  /** OpenRouter only: the operator confirmed BYOK-only routing in OpenRouter's dashboard. */
  byokOnlyConfirmed: boolean;
};

export const EMPTY_MANAGED_AI_SETTINGS: ManagedAiSettings = {
  engine: null,
  defaultModel: null,
  researchModel: null,
  transcriptionModel: null,
  byokOnlyConfirmed: false,
};

function selection(value: unknown): ModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const { provider, modelId } = value as { provider?: unknown; modelId?: unknown };
  if (typeof provider !== "string" || typeof modelId !== "string") return null;
  const p = provider.trim();
  const m = modelId.trim();
  if (!p || !m || p.length > 120 || m.length > 200) return null;
  return { provider: p, modelId: m };
}

/** A stored or submitted value made into settings; anything malformed is dropped. */
export function normalizeManagedAiSettings(value: unknown): ManagedAiSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const engine = MANAGED_AI_ENGINES.includes(raw.engine as ManagedAiEngine) ? (raw.engine as ManagedAiEngine) : null;
  return {
    engine,
    defaultModel: selection(raw.defaultModel),
    researchModel: selection(raw.researchModel),
    transcriptionModel: selection(raw.transcriptionModel),
    byokOnlyConfirmed: raw.byokOnlyConfirmed === true,
  };
}

/** Why the Included AI settings cannot run yet, or null when they can. Pure; the panel shows it. */
export function managedAiProblem(settings: ManagedAiSettings, stored: ReadonlySet<PlatformCredentialKey>): string | null {
  if (!settings.engine) return "Choose which engine Included workspaces use.";
  if (!stored.has(settings.engine)) return `Store the ${MANAGED_AI_ENGINE_LABEL[settings.engine]} key first.`;
  if (!settings.defaultModel) return "Choose the default model.";
  if (settings.engine === "anthropic") {
    if (settings.defaultModel.provider !== "anthropic") return "The default model must be a Claude model.";
    if (!ANTHROPIC_MODELS.some((model) => model.id === settings.defaultModel!.modelId)) return "Choose one of the listed Claude models.";
  }
  if (settings.engine === "aimlapi" && settings.defaultModel.provider !== "aimlapi") return "The default model must be an AI/ML API model.";
  if (settings.engine === "openrouter") {
    if (settings.defaultModel.provider === "aimlapi" || settings.defaultModel.provider === "anthropic") return "Name the OpenRouter upstream provider the model is pinned to.";
    if (!settings.byokOnlyConfirmed) return "Confirm BYOK-only routing in OpenRouter's dashboard, then here.";
  }
  return null;
}

/** "…a1b2" for a secret; never more than its last four characters. */
export function secretHint(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 8 ? "…" : `…${trimmed.slice(-4)}`;
}
