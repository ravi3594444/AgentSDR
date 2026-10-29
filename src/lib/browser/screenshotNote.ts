/**
 * What happens to a screenshot of the owner's page, in the words the app and
 * the extension both show (import-free: the extension bundles it). Keep it
 * true: the command row's image is blanked once the model has it
 * (connections.server.ts), but native Claude's own session files, under the
 * account's Claude config directory on the server, keep the conversation and
 * its images (docs/plans/INTERACTIVE_BROWSER_REPORT_2026-10-28.md).
 */
export const SCREENSHOT_NOTE =
  "When a step needs to see a page and the AI model takes images, it gets a screenshot of that tab. The app blanks its stored copy once the model has it. With a personally connected Claude login, Claude Code's own session history on the server can still keep those images.";
