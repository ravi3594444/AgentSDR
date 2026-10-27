import type { FeatureState } from "@/lib/features/catalog";

type Readiness = { available: boolean; reason?: string | null };

type ResearchSetup = {
  leadDiscovery: Readiness;
  webDiscovery: Readiness & { enabled: boolean; provider: string | null };
  webAccess: { tinyfish: boolean; searchProvider: string | null; browserMinutesPerDay: number };
  channels: { linkedin: Readiness };
  features: Pick<FeatureState, "apify_discovery" | "brightdata" | "treg">;
  /** The owner's own connected Chrome, in one sentence (browser_connection); absent outside a chat. */
  connectedBrowser?: string | null;
};

/** Configuration facts, not a preferred route. A configured tool can still fail at runtime. */
export function researchOptionsText(setup: ResearchSetup): string {
  const feature = (enabled: boolean) => enabled ? "enabled; its tool checks provider readiness and allowance" : "disabled";
  const options = [
    `Apify social searches: ${feature(setup.features.apify_discovery)}`,
    `Bright Data social research: ${feature(setup.features.brightdata)}`,
    `Browser: ${setup.webAccess.tinyfish ? `configured (${setup.webAccess.browserMinutesPerDay} minutes per day)` : "not configured"}`,
    ...(setup.connectedBrowser ? [`Connected browser (the owner's own Chrome, browser_tab tools): ${setup.connectedBrowser}`] : []),
    `Google Maps built-in scraper: ${setup.leadDiscovery.available ? "configured" : setup.leadDiscovery.reason ?? "not configured"}`,
    `LinkedIn people search: ${setup.channels.linkedin.available ? "connected account available" : setup.channels.linkedin.reason ?? "no ready account"}`,
    `Treg lookups: ${feature(setup.features.treg)}`,
    `Web search: ${setup.webAccess.searchProvider ? `configured (${setup.webAccess.searchProvider})` : "no direct search provider configured; see website search availability"}`,
    `Website and directory search: ${!setup.webDiscovery.enabled ? "disabled" : setup.webDiscovery.available ? `configured (${setup.webDiscovery.provider ?? "search provider"})` : setup.webDiscovery.reason ?? "not configured"}`,
  ];
  return `RESEARCH AVAILABILITY (alphabetical, not a preference; configuration does not confirm live provider health):\n${options.map((option) => `- ${option}`).join("\n")}`;
}

/** Keep the actual request ahead of saved business information on every model step. */
export function requestFirstContext(input: { request: string; setup: string; conversation: string; replanReason?: string | null }): string {
  return [
    input.request,
    `SAVED CONTEXT — background only. The current owner's request decides the audience and message purpose; saved products, target customers and locations do not add requirements.\n${input.setup}`,
    `CONVERSATION (newest last):\n${input.conversation}`,
    ...(input.replanReason ? [`Re-plan the remaining work: ${input.replanReason.slice(0, 600)}. Use the latest TOOL results and do not repeat successful actions.`] : []),
    "Your turn.",
  ].join("\n\n");
}
