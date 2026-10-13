/**
 * What this release of the product offers. The complete messaging workflow —
 * import leads, campaigns on email, LinkedIn and WhatsApp, replies, AI
 * classification and drafts you approve, the CRM — is in. The rest is hidden:
 * its code, routes and data stay, it is only unlinked from navigation,
 * settings and buttons, so a later release turns it back on here.
 *
 * Import-free and client-safe.
 */
export const RELEASE_FEATURES = {
  /** WhatsApp calls from the app: call campaigns, Call buttons, call history, the recorder extension, R2 recordings, transcription. */
  calling: false,
  /** Image-generating AI columns. */
  imageGeneration: false,
  /** LinkedIn lead search (finding new people), as opposed to messaging people already imported. */
  linkedinSearch: false,
  /** Tables, the enrichment grid. */
  tables: false,
  /** Domain qualification ("Prospecting"), slated for removal. */
  prospecting: false,
} as const;

export type ReleaseFeature = keyof typeof RELEASE_FEATURES;

export function isReleased(feature: ReleaseFeature): boolean {
  return RELEASE_FEATURES[feature];
}
