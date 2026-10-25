/**
 * The product's customer-facing identity, in one client-safe place (no
 * imports): the app shell, sign-in and setup, page titles and the auth email
 * all read it, so the brand changes here and nowhere else. The favicon
 * (src/app/icon.svg) and the Apple touch icon (src/app/apple-icon.tsx) draw
 * `monogram` too; change them together.
 *
 * This is product copy only. It is deliberately separate from:
 * - legal attribution: LICENSE and the upstream copyright notice stay as they
 *   are. The product is built on AgentSDR (MIT, github.com/Kandid-ai/AgentSDR);
 * - technical identifiers that still say "agentsdr" (message origins, the DOM
 *   attribute and window messages the call-recorder extension matches on,
 *   webhook names already registered in Unipile, package and cookie names).
 *   Other systems match on those, so renaming them breaks things.
 */
export const BRAND = {
  /** Full product name: page titles, auth pages, auth email. */
  name: "22nd x ai",
  /** Short form for running copy, e.g. "Not in 22nd X AI". */
  shortName: "22nd x ai",
  /** The text wordmark: `mark` set strong, `suffix` beneath it, quieter. */
  wordmark: { mark: "22nd x ai", suffix: "Outreach" },
  /** Letters on the app tile and favicon. */
  monogram: "22X",
  description: "Research relevant leads, prepare email, LinkedIn, WhatsApp and Instagram outreach, and keep replies in one workspace.",
  /**
   * Where an invite-only sign-in page's "Need access?" link writes to. Null
   * shows the hint without a link: people ask whoever runs this workspace.
   */
  accessRequestEmail: null as string | null,
} as const;

/** "<page> · <brand>": a page title with the product name after it. */
export function brandTitle(...parts: string[]): string {
  return [...parts, BRAND.name].join(" · ");
}
