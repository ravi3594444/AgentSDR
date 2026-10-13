"use client";

import { useEffect, useState } from "react";
import { RiCheckLine } from "@remixicon/react";
import AimlSettingsClient from "@/components/ai/AimlSettingsClient";
import ByokSettingsClient from "@/components/ai/ByokSettingsClient";
import { FormSkeleton } from "@/components/settings/SettingsSkeletons";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { cn } from "@/utils/cn";

type ProviderKey = "openrouter" | typeof AIML_PROVIDER_KEY;

const CHOICES: Array<{ key: ProviderKey; name: string; summary: string }> = [
  { key: "openrouter", name: "OpenRouter", summary: "Your own provider keys (BYOK) through OpenRouter. Needs an inference key, a management key and a routing confirmation. Supports web research, images and call transcription." },
  { key: AIML_PROVIDER_KEY, name: AIML_PROVIDER_NAME, summary: "One AI/ML API key for hundreds of models, billed to your AI/ML balance. Reply sorting, drafts and content AI columns." },
];

/**
 * AI Settings: which provider every AI feature uses, then that provider's own
 * setup. One provider is active per organization; it is whichever the last
 * saved settings point at, and saving the other panel switches to it.
 */
export default function AiSettingsClient() {
  const [active, setActive] = useState<ProviderKey | null>(null);
  const [view, setView] = useState<ProviderKey>("openrouter");
  const [loading, setLoading] = useState(true);

  async function loadActive(): Promise<ProviderKey | null> {
    const settings = await fetch("/api/ai/openrouter/settings").then((response) => response.ok ? response.json() as Promise<{ connectionId?: string | null }> : null);
    if (!settings?.connectionId) return null;
    const aiml = await fetch(`/api/grid/ai/providers/${AIML_PROVIDER_KEY}/connections`).then((response) => response.ok ? response.json() as Promise<{ connections?: Array<{ id: string }> }> : null);
    return aiml?.connections?.some((connection) => connection.id === settings.connectionId) ? AIML_PROVIDER_KEY : "openrouter";
  }

  useEffect(() => {
    let cancelled = false;
    void loadActive().then((key) => {
      if (cancelled) return;
      setActive(key);
      if (key) setView(key);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <FormSkeleton frames={3} />;

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="AI provider" className="grid gap-2 md:grid-cols-2">
        {CHOICES.map((choice) => {
          const shown = choice.key === view;
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
                  {active === choice.key && <span className="rounded-full bg-success-lighter px-2 py-0.5 text-label-xs text-success-dark">In use</span>}
                </span>
                <span className="mt-1 block text-paragraph-xs text-text-sub-600">{choice.summary}</span>
              </span>
              {shown && <RiCheckLine className="size-5 shrink-0 text-primary-base" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {view === AIML_PROVIDER_KEY
        ? <AimlSettingsClient key="aiml" onSaved={() => setActive(AIML_PROVIDER_KEY)} />
        : <ByokSettingsClient key="openrouter" onSaved={() => setActive("openrouter")} />}
    </div>
  );
}
