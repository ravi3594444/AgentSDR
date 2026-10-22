import Link from "next/link";
import * as Badge from "@/components/alignui/badge";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { formatAllowanceAmount } from "@/lib/managed/allowances";
import { SERVICE_MODE_LABEL } from "@/lib/managed/catalog";
import { planUsage } from "@/lib/managed/choices.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "Plan & usage" };
export const dynamic = "force-dynamic";

function resetDate(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : null;
}

/**
 * Your business → Plan & usage: what is included with the workspace, what is
 * left of each monthly allowance and when it resets, and which providers run
 * on the workspace's own accounts instead. Figures AgentSDR counts or
 * estimates itself say so.
 */
export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { choices, allowances } = await runInOrganization(ctx.organizationId, () => planUsage());
  const own = choices.filter((choice) => choice.mode === "own");
  return (
    <SettingsPage
      title="Plan & usage"
      description="Your workspace includes AI, lead research and account connections, each with a monthly allowance. Nothing here needs an account or key of your own."
      width="narrow"
    >
      <div className="flex flex-col gap-6">
        <Frame>
          <FrameHeader title="Included this month" description="Used and left of each allowance. Allowances reset on the 1st of the month (UTC); connected accounts are a standing count." />
          <FramePanel>
            {allowances.length === 0 && <p className="text-paragraph-sm text-text-sub-600">Every provider runs on your own accounts, so no included allowance applies.</p>}
            <ul className="flex flex-col">
              {allowances.map((allowance) => {
                const share = allowance.limit > 0 ? Math.min(100, Math.round((allowance.used / allowance.limit) * 100)) : 100;
                const reset = resetDate(allowance.resetsAt);
                return (
                  <li key={allowance.key} className="flex flex-col gap-2 border-b border-stroke-soft-200 py-3 last:border-b-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-label-sm text-text-strong-950">{allowance.label}</span>
                      <span className="text-paragraph-sm text-text-strong-950">
                        {formatAllowanceAmount(allowance.remaining, allowance.unit)} left
                        <span className="text-text-sub-600"> of {formatAllowanceAmount(allowance.limit, allowance.unit)}{allowance.estimated ? " (estimated)" : ""}</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-soft-200" aria-hidden="true">
                      <div className={`h-full rounded-full ${share >= 100 ? "bg-error-base" : share >= 80 ? "bg-warning-base" : "bg-primary-base"}`} style={{ width: `${share}%` }} />
                    </div>
                    <span className="text-paragraph-xs text-text-sub-600">
                      {formatAllowanceAmount(allowance.used, allowance.unit)} used{reset ? `; resets on ${reset}` : ""}.
                    </span>
                  </li>
                );
              })}
            </ul>
          </FramePanel>
        </Frame>
        <Frame>
          <FrameHeader title="Your providers" description="Which services run on what is included, and which on your own accounts." />
          <FramePanel>
            <ul className="flex flex-col">
              {choices.map((choice) => (
                <li key={choice.service} className="flex flex-col gap-1 border-b border-stroke-soft-200 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-paragraph-sm text-text-strong-950">{choice.label}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge.Root variant="lighter" size="small" color={choice.mode === "managed" ? (choice.includedAvailable ? "green" : "orange") : "blue"}>
                      {SERVICE_MODE_LABEL[choice.mode]}{choice.mode === "managed" && !choice.includedAvailable ? ": not available right now" : ""}
                    </Badge.Root>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-paragraph-xs text-text-sub-600">
              {own.length ? `${own.length} ${own.length === 1 ? "service runs" : "services run"} on your own account and ${own.length === 1 ? "is" : "are"} not counted here. ` : ""}
              To change this, go to <Link className="underline" href="/settings/providers">Advanced → Use your own providers</Link>.
            </p>
          </FramePanel>
        </Frame>
      </div>
    </SettingsPage>
  );
}
