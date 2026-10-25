# Current request and neutral tool guidance — 25 October 2026

Base: `2c0e523` on `codex/reply-release-20261023`.

## Reported behavior and causes

An owner asked to find established businesses and ask which services cost
them the most. The assistant added the saved AI/CRM offer to the goal and
searched familiar real-estate and cleaning segments through Maps.

The prompt still said to find who needs the saved offer most when the
audience is open. Saved business information preceded the request in the
model context. Setup singled out Google Maps as the ready lead search.
The brief had nowhere to distinguish the model's research strategy from
the owner's goal. Finally, the plan stored the owner's request but did not
pass it to its message writers; those always requested a sales opener.

## Changes

- The request is first on every research-model step. Saved business facts
  remain available and are explicitly background, not extra requirements.
- The method distinguishes the requested audience, message purpose and
  outcome from the assistant's provisional search choices. The saved offer
  guides a buyer search when the owner asks for buyers of that offer.
- A brief can store optional `approach` text in its existing JSON. It is
  labelled as the assistant's revisable strategy, separately from `goal`.
  Existing briefs without the field still read normally; no migration.
- Tools and source references are alphabetical, with no default source or
  quotas requiring every provider to run. The model chooses by relevance,
  evidence, reachability, configuration and actual results. Feature and
  provider limits still describe real capability differences.
- Setup and check_setup use the same availability block for Maps, web,
  browser, LinkedIn, Apify, Bright Data and Treg. Configuration is not
  presented as proof of live provider health. Unsaved profile fields do
  not make an open audience or place a missing request requirement.
- Saving business information distinguishes lasting preferences from a
  one-off audience, place or question. Treg's description no longer makes
  it a last resort for lookups other tools cannot perform.
- Sequence writing, review, personal messages and opening lines receive
  the current owner request. Opening lines at Start receive the plan's
  stored request too. A specific message purpose takes precedence over
  the default sales style; requests to learn something need not pitch a
  product. Ordinary sales outreach still uses the saved business offer.

These changes add no model calls and change no sender queues, sending
rules, claim ownership, DNC, budget enforcement or grounding checks.
Existing prepared messages are not rewritten or resent by deployment.

## Verification

- TypeScript and changed-file ESLint: pass.
- Application/scripts unit suite under TZ=UTC: 2,252 pass, zero failures.
- research-agent-v2: 51 checks pass on a fresh disposable PGlite database.
  The real turn supplies the request before the business profile; approach
  survives storage separately; each writing stage receives the request.
- assistant: 73 checks pass on a separate fresh PGlite database. Its old
  Maps-only setup assertion was updated to require the neutral availability
  block and retain the sender/profile checks. The local email fixture uses
  a fake unsubscribe secret; no real email is sent.
- Organization-scope contract: pass.
- Production webpack build: exit 0. Google Fonts uses a non-shipped offline
  build fixture outside the repository because network access is limited.
- AST graph rebuilt locally. The generated graph exceeds the connector's
  snapshot limit and is reproducible with `graphify update .`.

These checks prove configuration, persistence and wiring using stand-ins.
No live model or research provider was called, no real messages were sent,
and no VM deployment was performed here. They do not prove perfect source
selection or understanding by every model, or close the separate safety
audit findings. Native multi-connection PostgreSQL was not exercised.

After deployment, repeat the original request in a new chat. Check that the
goal preserves its question, any chosen sectors/places are an explained
approach rather than owner restrictions, and the sample asks the requested
question. Maps may still be appropriate; the acceptance check is relevance
and evidence, not a requirement to invoke every source.

The owner's separate WhatsApp test confirmed that the automatic business
welcome was left unanswered. Its existing no-reply rule was not changed.
