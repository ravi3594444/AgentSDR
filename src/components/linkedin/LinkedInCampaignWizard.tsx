"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, FileSpreadsheet, Loader2, Rocket, Users } from "lucide-react";
import { RiCheckLine, RiDraftLine, RiStackLine, RiTeamLine } from "@remixicon/react";
import * as AlignButton from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Textarea from "@/components/alignui/textarea";
import AddPeopleToCampaignModal from "@/components/leads/AddPeopleToCampaignModal";
import CampaignCsvMappingDialog from "@/components/leads/CampaignCsvMappingDialog";
import { LinkedInAccountTag } from "@/components/linkedin/LinkedInAccountTag";
import { LinkedInSequenceEditor } from "@/components/linkedin/LinkedInSequenceEditor";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { DocsLink } from "@/components/page/DocsLink";
import { PageHeader } from "@/components/page/PageHeader";
import { EMPTY_LINKEDIN_SEQUENCE, type LinkedinCampaignSequence } from "@/lib/linkedin/campaignSequence";
import { cn } from "@/utils/cn";
import { BRAND } from "@/lib/brand";

type Account = { id: string; username: string; name: string | null; profilePictureUrl: string | null };

const STEPS = [
  { id: "setup", label: "Campaign details", hint: "Name and senders", icon: RiDraftLine },
  { id: "leads", label: "Add leads", hint: "People or spreadsheet", icon: RiTeamLine },
  { id: "sequence", label: "Build sequence", hint: "Write and preview messages", icon: RiStackLine },
  { id: "review", label: "Review & launch", hint: "Confirm send readiness", icon: RiCheckLine },
] as const;

function StepDot({ index, active, done }: { index: number; active: boolean; done: boolean }) {
  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg text-label-xs transition",
        done
          ? "bg-success-lighter text-success-base"
          : active
            ? "bg-primary-base text-static-white shadow-regular-xs"
            : "bg-bg-weak-50 text-text-soft-400",
      )}
    >
      {done ? <RiCheckLine className="size-4" /> : index + 1}
    </div>
  );
}

export function LinkedInCampaignWizard({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"REGULAR" | "PERSONAL">("REGULAR");
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [leadCount, setLeadCount] = useState(0);
  const [sequence, setSequence] = useState<LinkedinCampaignSequence>(EMPTY_LINKEDIN_SEQUENCE);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);

  async function saveSetup() {
    if (!name.trim()) { setError("Enter a campaign name"); return; }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(campaignId ? `/api/linkedin/campaigns/${campaignId}` : "/api/linkedin/campaigns", {
        method: campaignId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null, type, linkedinAccountIds: accountIds, ...(!campaignId ? { status: "PAUSED" } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error ?? "Could not save campaign");
      if (!campaignId) setCampaignId(data.campaign.id);
      setStep(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save campaign");
    } finally {
      setBusy(false);
    }
  }

  async function finish(status: "PAUSED" | "ACTIVE") {
    if (!campaignId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/linkedin/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error ?? "Could not finish campaign");
      router.push(`/linkedin/campaigns/${campaignId}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not finish campaign");
    } finally {
      setBusy(false);
    }
  }

  const canLaunch = leadCount > 0 && accountIds.length > 0;
  const sequenceStepsBuilt = STEPS_FOR_SUMMARY(sequence).filter((item) => item.enabled).length;

  return (
    <div className="mx-auto w-full max-w-[1440px]">
      <PageHeader
        back={{ href: "/linkedin/campaigns", label: "LinkedIn campaigns" }}
        title="Create a LinkedIn campaign"
        description="Choose senders, add leads, write the sequence and preview it with real lead data. It stays paused until you launch it."
      />

      <div className="mt-6 grid grid-cols-1 items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-5">
        <Frame>
          <FrameHeader title="Steps" description={`Step ${step + 1} of ${STEPS.length}`} />
          <FramePanel className="p-2 sm:p-2">
            <ol className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-1">
              {STEPS.map((item, index) => {
                const active = index === step;
                const done = index < step;
                const reachable = index <= step;
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={!reachable || active}
                      onClick={() => reachable && setStep(index)}
                      aria-current={active ? "step" : undefined}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition duration-200 ease-out",
                        active ? "bg-bg-weak-50" : reachable ? "hover:bg-bg-weak-50" : "cursor-default",
                      )}
                    >
                      <StepDot index={index} active={active} done={done} />
                      <span className="min-w-0">
                        <span className={cn("block text-label-sm", active ? "text-text-strong-950" : "text-text-sub-600")}>{item.label}</span>
                        <span className="mt-0.5 hidden text-paragraph-xs text-text-soft-400 lg:block">{item.hint}</span>
                      </span>
                      <Icon className="ml-auto hidden size-4 text-text-soft-400 sm:block lg:hidden" />
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="mx-1 mb-1 mt-3 hidden border-t border-stroke-soft-200 px-2 pt-3 lg:block">
              <p className="text-paragraph-xs text-text-soft-400">Summary</p>
              <dl className="mt-2 space-y-2 text-paragraph-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-sub-600">Name</dt>
                  <dd className="min-w-0 truncate text-label-sm text-text-strong-950">{name || "Not named yet"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-sub-600">Senders</dt>
                  <dd className="text-label-sm tabular-nums text-text-strong-950">{accountIds.length.toLocaleString()}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-sub-600">Leads</dt>
                  <dd className="text-label-sm tabular-nums text-text-strong-950">{leadCount.toLocaleString()}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-sub-600">Sequence</dt>
                  <dd className="text-label-sm tabular-nums text-text-strong-950">{sequenceStepsBuilt} step{sequenceStepsBuilt === 1 ? "" : "s"}</dd>
                </div>
              </dl>
            </div>
          </FramePanel>
        </Frame>

        <Frame>
          <FramePanel className="min-h-[560px] p-5 sm:p-7">
            {step === 0 && (
              <div className="mx-auto max-w-2xl">
                <StepHeading title="Campaign details" description="Choose a clear name and the LinkedIn accounts that can send." />
                <div className="mt-6 space-y-5">
                  <label className="block">
                    <span className="mb-1.5 block text-label-sm text-text-strong-950">Campaign name</span>
                    <Input.Root hasError={Boolean(error && !name.trim())}>
                      <Input.Wrapper>
                        <Input.Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. SaaS founders · India" autoFocus />
                      </Input.Wrapper>
                    </Input.Root>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-label-sm text-text-strong-950">Description <span className="text-text-soft-400">(optional)</span></span>
                    <Textarea.Root simple rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this campaign for?" />
                  </label>
                  <fieldset>
                    <legend className="mb-2 block text-label-sm text-text-strong-950">Campaign type</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["REGULAR", "PERSONAL"] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={type === value}
                          onClick={() => setType(value)}
                          className={cn(
                            "rounded-xl p-4 text-left outline-none ring-1 ring-inset transition focus-visible:ring-2 focus-visible:ring-primary-base",
                            type === value ? "bg-bg-weak-50 ring-primary-base" : "bg-bg-white-0 ring-stroke-soft-200 hover:bg-bg-weak-50",
                          )}
                        >
                          <span className="text-label-sm text-text-strong-950">{value === "REGULAR" ? "Regular" : "Personal"}</span>
                          <span className="mt-1 block text-paragraph-xs text-text-sub-600">
                            {value === "REGULAR" ? `Visible in Messages and shared with ${BRAND.shortName}.` : "Kept out of the shared Messages workspace."}
                          </span>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="mb-2 block text-label-sm text-text-strong-950">LinkedIn senders</legend>
                    {accounts.length === 0 ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-warning-lighter p-3 text-paragraph-sm text-warning-dark">
                        <span className="min-w-0 flex-1">Connect a LinkedIn account before launching. You can still save this campaign paused.</span>
                        <span className="flex flex-wrap items-center gap-3 text-paragraph-xs">
                          <Link href="/settings/linkedin-accounts" className="font-medium underline underline-offset-2">
                            Connect an account
                          </Link>
                          <DocsLink page="linkedin/accounts#add-a-linkedin-account" appearance="inline" className="text-current underline" />
                        </span>
                      </div>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {accounts.map((account) => {
                          const checked = accountIds.includes(account.id);
                          return (
                            <label
                              key={account.id}
                              className={cn("flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 ring-inset transition", checked ? "bg-bg-weak-50 ring-primary-base" : "ring-stroke-soft-200 hover:bg-bg-weak-50")}
                            >
                              <Checkbox.Root
                                checked={checked}
                                onCheckedChange={() => setAccountIds((current) => (checked ? current.filter((id) => id !== account.id) : [...current, account.id]))}
                              />
                              <LinkedInAccountTag account={account} size="sm" />
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </fieldset>
                </div>
                <WizardFooter error={error} backLabel="Cancel" onBack={() => router.push("/linkedin/campaigns")} onNext={() => void saveSetup()} busy={busy} nextLabel="Continue to leads" />
              </div>
            )}

            {step === 1 && campaignId && (
              <div className="mx-auto max-w-3xl">
                <StepHeading title="Add leads" description="Import a spreadsheet and review its column mapping, or select people already in your database." />
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <button type="button" onClick={() => fileRef.current?.click()} className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-stroke-sub-300 bg-bg-weak-50 p-6 text-center outline-none transition hover:border-primary-base focus-visible:ring-2 focus-visible:ring-primary-base">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200"><FileSpreadsheet className="size-5 text-text-sub-600" /></span>
                    <span className="mt-3 text-label-md text-text-strong-950">Import CSV or Excel</span>
                    <span className="mt-1 text-paragraph-xs text-text-sub-600">You will map every important column before anything is imported.</span>
                  </button>
                  <button type="button" onClick={() => setShowPeople(true)} className="flex min-h-44 flex-col items-center justify-center rounded-2xl bg-bg-white-0 p-6 text-center shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200"><Users className="size-5 text-text-sub-600" /></span>
                    <span className="mt-3 text-label-md text-text-strong-950">Add from People</span>
                    <span className="mt-1 text-paragraph-xs text-text-sub-600">Select existing people who already have a LinkedIn profile.</span>
                  </button>
                </div>
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(event) => setPendingFile(event.target.files?.[0] ?? null)} />
                <div role="status" className="mt-4 rounded-xl bg-bg-weak-50 p-4 ring-1 ring-inset ring-stroke-soft-200">
                  <p className="text-label-sm text-text-strong-950">{leadCount.toLocaleString()} {leadCount === 1 ? "lead" : "leads"} added</p>
                  <p className="mt-1 text-paragraph-xs text-text-sub-600">{importSummary ?? "You can continue with no leads and add them later. The campaign stays paused."}</p>
                </div>
                <WizardFooter error={error} onBack={() => setStep(0)} onNext={() => setStep(2)} nextLabel="Continue to sequence" />
                {pendingFile && (
                  <CampaignCsvMappingDialog
                    file={pendingFile}
                    endpoint={`/api/linkedin/campaigns/${campaignId}/upload`}
                    channel="linkedin"
                    onClose={() => { setPendingFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                    onImported={(result) => {
                      const added = Number(result.created ?? 0) + Number(result.attached ?? 0);
                      setLeadCount((current) => current + added);
                      setImportSummary(`${added} added${Number(result.failed ?? 0) ? ` · ${Number(result.failed)} failed` : ""}`);
                      setPendingFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                  />
                )}
                {showPeople && (
                  <AddPeopleToCampaignModal
                    campaignId={campaignId}
                    channel="linkedin"
                    onClose={() => setShowPeople(false)}
                    onAdded={(result) => {
                      setLeadCount((current) => current + result.added);
                      setImportSummary(`${result.added} added from People${result.skippedDuplicate ? ` · ${result.skippedDuplicate} already enrolled` : ""}`);
                    }}
                  />
                )}
              </div>
            )}

            {step === 2 && campaignId && (
              <div>
                <StepHeading title="Build your sequence" description="Personalise each stage with People fields and preview the final message." />
                <div className="mt-5">
                  <LinkedInSequenceEditor campaignId={campaignId} initialSequence={sequence} saveLabel="Save and review" onSaved={(next) => { setSequence(next); setStep(3); }} />
                </div>
                <div className="mt-5">
                  <AlignButton.Root variant="neutral" mode="ghost" size="small" onClick={() => setStep(1)}>
                    <AlignButton.Icon as={ArrowLeft} />Back to leads
                  </AlignButton.Root>
                </div>
              </div>
            )}

            {step === 3 && campaignId && (
              <div className="mx-auto max-w-3xl">
                <StepHeading title="Review and launch" description="Your campaign is paused until you explicitly launch it." />
                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  <SummaryCard label="Campaign" value={name} detail={type === "PERSONAL" ? "Personal" : "Regular"} />
                  <SummaryCard label="Leads" value={leadCount.toLocaleString()} detail="enrolled" />
                  <SummaryCard label="Senders" value={accountIds.length.toLocaleString()} detail="connected accounts" />
                </div>
                <div className="mt-4 rounded-2xl bg-bg-weak-50 p-1 ring-1 ring-inset ring-stroke-soft-200">
                  <h3 className="px-3 pb-2 pt-2 text-label-sm text-text-strong-950">Sequence</h3>
                  <ul className="divide-y divide-stroke-soft-200 rounded-xl bg-bg-white-0 px-4 ring-1 ring-inset ring-stroke-soft-200">
                    {STEPS_FOR_SUMMARY(sequence).map((item) => (
                      <li key={item.label} className="flex items-center justify-between gap-4 py-2.5 text-paragraph-sm">
                        <span className="text-text-sub-600">{item.label}</span>
                        <span className={cn("inline-flex items-center gap-1", item.enabled ? "text-success-base" : "text-text-soft-400")}>
                          {item.enabled && <RiCheckLine className="size-4" aria-hidden="true" />}
                          {item.enabled ? "Ready" : "Skipped"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {!canLaunch && <p className="mt-4 rounded-xl bg-warning-lighter p-3 text-paragraph-sm text-warning-dark">Add at least one lead and one sender before launching. You can save it paused and finish later.</p>}
                <WizardFooter error={error} onBack={() => setStep(2)} busy={busy} secondaryLabel="Save paused" onSecondary={() => void finish("PAUSED")} nextLabel="Launch campaign" onNext={() => void finish("ACTIVE")} nextDisabled={!canLaunch} nextIcon={Rocket} />
              </div>
            )}
          </FramePanel>
        </Frame>
      </div>
    </div>
  );
}

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-label-lg text-text-strong-950">{title}</h2>
      <p className="mt-1 text-paragraph-sm text-text-sub-600">{description}</p>
    </div>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="rounded-xl bg-bg-white-0 p-4 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200"><p className="text-paragraph-xs text-text-sub-600">{label}</p><p className="mt-1 truncate text-label-lg text-text-strong-950" title={value}>{value}</p><p className="text-paragraph-xs text-text-sub-600">{detail}</p></div>; }
function STEPS_FOR_SUMMARY(sequence: LinkedinCampaignSequence) { return [{ label: "Connection request", enabled: Boolean(sequence.invitationMessage) }, { label: "Acceptance message", enabled: Boolean(sequence.acceptanceMessage) }, { label: "Follow-up 1", enabled: Boolean(sequence.followUp1Message) }, { label: "Follow-up 2", enabled: Boolean(sequence.followUp2Message) }, { label: "Follow-up 3", enabled: Boolean(sequence.followUp3Message) }]; }

function WizardFooter({ error, onBack, onNext, busy, backLabel = "Back", nextLabel, nextDisabled, secondaryLabel, onSecondary, nextIcon: NextIcon = ArrowRight }: { error?: string | null; onBack: () => void; onNext: () => void; busy?: boolean; backLabel?: string; nextLabel: string; nextDisabled?: boolean; secondaryLabel?: string; onSecondary?: () => void; nextIcon?: typeof ArrowRight }) {
  return <div className="mt-8 border-t border-stroke-soft-200 pt-5">{error && <p role="alert" className="mb-3 text-paragraph-sm text-error-base">{error}</p>}<div className="flex flex-wrap items-center justify-between gap-3"><AlignButton.Root variant="neutral" mode="ghost" size="small" onClick={onBack} disabled={busy}><AlignButton.Icon as={ArrowLeft} />{backLabel}</AlignButton.Root><div className="flex gap-2">{secondaryLabel && onSecondary && <AlignButton.Root variant="neutral" mode="stroke" size="small" onClick={onSecondary} disabled={busy}>{secondaryLabel}</AlignButton.Root>}<AlignButton.Root variant="primary" mode="filled" size="small" onClick={onNext} disabled={busy || nextDisabled}>{busy ? <AlignButton.Icon as={Loader2} className="animate-spin" /> : <AlignButton.Icon as={NextIcon} />}{busy ? "Saving…" : nextLabel}</AlignButton.Root></div></div></div>;
}
