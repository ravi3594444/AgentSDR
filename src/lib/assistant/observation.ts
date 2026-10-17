const SNAPSHOT_TOOLS = new Set([
  "report",
  "diagnose_delivery",
  "check_setup",
  "list_runs",
]);

/** Read the same status once per turn, until a mutation makes it worth reading again. */
export function observationKey(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  if (!SNAPSHOT_TOOLS.has(tool)) return null;
  return `${tool}:${JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))))}`;
}
