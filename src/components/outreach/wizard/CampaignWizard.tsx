"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  RiCheckLine,
  RiDraftLine,
  RiStackLine,
  RiTeamLine,
} from "@remixicon/react";
import type { SequenceStep } from "@/lib/outreach/schema";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { PageHeader } from "@/components/page/PageHeader";
import { cn } from "@/utils/cn";
import StepName from "./StepName";
import StepLeads from "./StepLeads";
import StepSequence from "./StepSequence";
import StepReview from "./StepReview";

const STEPS = [
  { id: "name", label: "Campaign details", hint: "Name this campaign", icon: RiDraftLine },
  { id: "leads", label: "Add leads", hint: "People or spreadsheet", icon: RiTeamLine },
  { id: "sequence", label: "Build sequence", hint: "Write and preview emails", icon: RiStackLine },
  { id: "review", label: "Review & launch", hint: "Confirm send readiness", icon: RiCheckLine },
] as const;

type StepId = (typeof STEPS)[number]["id"];

export type WizardState = {
  campaignId: string | null;
  name: string;
  leadCount: number;
  sequence: SequenceStep[];
};

function StepDot({ index, active, done }: { index: number; active: boolean; done: boolean }) {
  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg text-label-xs transition",
        done
          ? "bg-success-lighter text-success-base"
          : active
            ? "bg-primary-base text-primary-contrast shadow-regular-xs"
            : "bg-bg-weak-50 text-text-soft-400",
      )}
    >
      {done ? <RiCheckLine className="size-4" /> : index + 1}
    </div>
  );
}

export default function CampaignWizard() {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [state, setState] = useState<WizardState>({
    campaignId: null,
    name: "",
    leadCount: 0,
    sequence: [],
  });

  const step = STEPS[stepIndex];

  function goTo(id: StepId) {
    setStepIndex(STEPS.findIndex((s) => s.id === id));
  }

  function patch(update: Partial<WizardState>) {
    setState((prev) => ({ ...prev, ...update }));
  }

  return (
    <div>
      <PageHeader
        back={{ href: "/outreach/campaigns", label: "Send campaigns" }}
        title="Create a send campaign"
        description="Add recipients, build the sequence, preview it with real lead data, then launch."
      />

      <div className="mt-6 grid grid-cols-1 items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-5">
        <Frame>
          <FrameHeader title="Steps" description={`Step ${stepIndex + 1} of ${STEPS.length}`} />
          <FramePanel className="p-2 sm:p-2">
          <ol className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-1">
            {STEPS.map((item, index) => {
              const active = index === stepIndex;
              const done = index < stepIndex;
              const reachable = index <= stepIndex;
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={!reachable || active}
                    onClick={() => reachable && goTo(item.id)}
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
                <dd className="min-w-0 truncate text-label-sm text-text-strong-950">{state.name || "Not named yet"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-text-sub-600">Leads</dt>
                <dd className="text-label-sm tabular-nums text-text-strong-950">{state.leadCount.toLocaleString()}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-text-sub-600">Sequence</dt>
                <dd className="text-label-sm tabular-nums text-text-strong-950">{state.sequence.length} step{state.sequence.length === 1 ? "" : "s"}</dd>
              </div>
            </dl>
          </div>
          </FramePanel>
        </Frame>

        <Frame>
          <FramePanel className="min-h-[560px] p-5 sm:p-7">
          {step.id === "name" && (
            <StepName
              campaignId={state.campaignId}
              name={state.name}
              onNameChange={(name) => patch({ name })}
              onContinue={(campaignId) => {
                patch({ campaignId });
                goTo("leads");
              }}
            />
          )}

          {step.id === "leads" && state.campaignId && (
            <StepLeads
              campaignId={state.campaignId}
              onBack={() => goTo("name")}
              onContinue={(leadCount) => {
                patch({ leadCount });
                goTo("sequence");
              }}
            />
          )}

          {step.id === "sequence" && state.campaignId && (
            <StepSequence
              campaignId={state.campaignId}
              initialSequence={state.sequence}
              onBack={() => goTo("leads")}
              onContinue={(sequence) => {
                patch({ sequence });
                goTo("review");
              }}
            />
          )}

          {step.id === "review" && state.campaignId && (
            <StepReview
              campaignId={state.campaignId}
              name={state.name}
              leadCount={state.leadCount}
              sequence={state.sequence}
              onBack={() => goTo("sequence")}
              onDone={(campaignId) => router.push(`/outreach/campaigns/${campaignId}`)}
            />
          )}
          </FramePanel>
        </Frame>
      </div>
    </div>
  );
}
