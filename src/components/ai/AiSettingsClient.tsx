"use client";

import { useEffect, useState } from "react";
import { RiCheckLine } from "@remixicon/react";
import AimlSettingsClient from "@/components/ai/AimlSettingsClient";
import ByokSettingsClient from "@/components/ai/ByokSettingsClient";
import ClaudeCodeSettingsClient from "@/components/ai/ClaudeCodeSettingsClient";
import { FormSkeleton } from "@/components/settings/SettingsSkeletons";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { CLAUDE_CODE_ENGINE_KEY, CLAUDE_CODE_ENGINE_NAME } from "@/lib/ai/claudeCode/contract";
import { cn } from "@/utils/cn";

type ProviderKey = "openrouter" | typeof AIML_PROVIDER_KEY;
type ChoiceKey = ProviderKey | typeof CLAUDE_CODE_ENGINE_KEY;

const CLAUDE_CHOICE = { key: CLAUDE_CODE_ENGINE_KEY, name: CLAUDE_CODE_ENGINE_NAME, summary: "Your own Claude account, through Anthropic's Claude Code on this server. Owner-only pilot: the app's AI steps use your account's limits; API features stay on the provider." } as const;

const CHOICES: Array<{ key: ChoiceKey; name: string; summary: string }> = [
  { key: "openrouter", name: "OpenRouter", summary: "Your own provider keys (BYOK) through OpenRouter. Needs an inference key, a management key and a routing confirmation. Supports web research, images and call transcription." },
  { key: AIML_PROVIDER_KEY, name: AIML_PROVIDER_NAME, summary: "One AI/ML API key for hundreds of models, billed to your AI/ML balance. Reply sorting, drafts and content AI columns." },
];

/**
 * AI Settings: which provider every AI feature uses, then that provider's own
 * setup. One provider is active per organization; it is whichever the last
 * saved settings point at, and saving the other panel switches to it.
 * Claude Code, offered only to an owner of the operator organization, sits
 * on top: while it is in use the app's AI steps run on it and the API
 * provider keeps the features it alone offers.
 */
export default function AiSettingsClient() {
  const [active, setActive] = useState<ProviderKey | null>(null);
  const [view, setView] = useState<ChoiceKey>("openrouter");
  const [loading, setLoading] = useState(true);
  const [claude, setClaude] = useState<{ allowed: boolean; selected: boolean }>({ allowed: false, selected: false });

  async function loadClaude() {
    const status = await fetch("/api/ai/claude-code", { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ allowed?: boolean; engine?: { selected?: boolean } }> : null).catch(() => null);
    return { allowed: status?.allowed === true, selected: status?.engine?.selected === true };
  }

  async function loadActive(): Promise<ProviderKey | null> {
    const settings = await fetch("/api/ai/openrouter/settings").then((response) => response.ok ? response.json() as Promise<{ connectionId?: string | null }> : null);
    if (!settings?.connectionId) return null;
    const aiml = await fetch(`/api/grid/ai/providers/${AIML_PROVIDER_KEY}/connections`).then((response) => response.ok ? response.json() as Promise<{ connections?: Array<{ id: string }> }> : null);
    return aiml?.connections?.some((connection) => connection.id === settings.connectionId) ? AIML_PROVIDER_KEY : "openrouter";
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadActive(), loadClaude()]).then(([key, claudeState]) => {
      if (cancelled) return;
      setActive(key);
      setClaude(claudeState);
      if (claudeState.selected && claudeState.allowed) setView(CLAUDE_CODE_ENGINE_KEY);
      else if (key) setView(key);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <FormSkeleton frames={3} />;

  return (
    <div className="space-y-4">
      {claude.selected && !claude.allowed && (
        <p className="rounded-xl bg-information-lighter px-3.5 py-3 text-paragraph-sm text-information-dark ring-1 ring-inset ring-information-light">
          This organization&apos;s AI steps run on an owner&apos;s own Claude account through Claude Code. The provider below keeps table AI columns, AI web search and call transcription. Only that owner can change this.
        </p>
      )}
      <div role="radiogroup" aria-label="AI provider" className={cn("grid gap-2 md:grid-cols-2", claude.allowed && "xl:grid-cols-3")}>
        {[...CHOICES, ...(claude.allowed ? [CLAUDE_CHOICE] : [])].map((choice) => {
          const shown = choice.key === view;
          const inUse = choice.key === CLAUDE_CODE_ENGINE_KEY ? claude.selected : active === choice.key;
          return (
            <button
              key={choice.key}
              type="button"
              role="radio"
              aria-checked={shown}
              onClick={() => setView(choice.key)}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl px-4 py-3 text-left outline-none ring-inset transition focus-visible:shadow-button-important-focus",
                shown ? "bg-bg-white-0 ring-2 ring-primary-base" : "ring-1 ring-stroke-soft-200 hover:bg-bg-weak-50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-label-sm text-text-strong-950">{choice.name}</span>
                  {inUse && <span className="rounded-full bg-success-lighter px-2 py-0.5 text-label-xs text-success-dark">{choice.key !== CLAUDE_CODE_ENGINE_KEY && claude.selected ? "In use for API features" : "In use"}</span>}
                </span>
                <span className="mt-1 block text-paragraph-xs text-text-sub-600">{choice.summary}</span>
              </span>
              {shown && <RiCheckLine className="size-5 shrink-0 text-primary-base" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {view === CLAUDE_CODE_ENGINE_KEY
        ? <ClaudeCodeSettingsClient key="claude-code" onChanged={() => { void loadClaude().then(setClaude); }} />
        : view === AIML_PROVIDER_KEY
          ? <AimlSettingsClient key="aiml" onSaved={() => setActive(AIML_PROVIDER_KEY)} />
          : <ByokSettingsClient key="openrouter" onSaved={() => setActive("openrouter")} />}
    </div>
  );
}
