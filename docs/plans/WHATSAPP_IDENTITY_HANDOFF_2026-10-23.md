# WhatsApp phone/privacy identity handoff — 23 October 2026

## Confirmed incident

The VM stored inbound `Hey` / `Hi` messages but left their CRM message links empty. No classification or reply-agent job existed for those messages. The CRM bridge audit recorded `Provider thread and contact identities disagree`.

The owner's read-only query showed the same saved contact and thread using a WhatsApp privacy identifier ending in `@lid` in the chat, while one CRM conversation still held that person's phone identifier ending in `@s.whatsapp.net`. Another conversation already used the matching privacy identifier. The exact-string identity check rejected the phone/privacy transition before an AI reply was requested.

This evidence establishes the WhatsApp handoff defect. It does not establish an email, LinkedIn or Instagram failure, and it is separate from the sender-gap deferral fixed in `fc34d5b`.

## Changes

- Normalize equivalent phone identifiers and device suffixes without interpreting a privacy ID as a phone number.
- Permit a phone/privacy transition only on the same stored account, thread and canonical Person, with matching stored chat/contact phones. An incoming privacy ID must match the chat's stored provider ID. Different phone numbers, unrelated privacy IDs and reassignment to another Person remain conflicts. Other channels retain their strict checks.
- Lock WhatsApp conversation identity by thread when available, so phone and privacy aliases use the same advisory lock.
- Keep raw incoming messages when the CRM fails, but mark the inbound processing failure instead of treating a missing CRM handoff as success.
- On redelivery, finish a stored inbound message's missing handoff instead of discarding it as an already processed duplicate. Reuse CRM message/job idempotency.
- Recover only a latest unsuperseded message. Do not revive historical replies after a newer chat message or CRM inbound turn.
- Package an operator recovery command in the production image. Its default is a read-only preview. Applying it queues the selected phone's latest saved inbound through the ordinary reply worker; it does not send directly or bypass Review, Do Not Contact, stale-message, sender or idempotency guards. It requires one unambiguous workspace and an active, started WhatsApp plan.

No database migration, provider-setting change, sending-limit change or reporting-definition change is included.

## Verification

- Typecheck and lint: pass.
- Unit tests: 2,215 pass, 0 fail (`TZ=UTC`).
- New WhatsApp handoff database suite: 14 checks pass, including CRM-write fault injection, stored-message retry, phone/privacy alias transition, real classification/reply/send wiring with stand-ins, duplicate prevention, genuine identity conflicts, historical-message refusal and another workspace's 404.
- Existing workspace replay: 107 checks pass.
- Existing reply-delivery suite: 21 checks pass.
- Deploy packaging tests: 25 pass, including the script's Docker build-context inclusion.
- Packaged recovery bundle: preview leaves data unchanged; apply links the latest inbound and creates exactly one classification job; repeating apply reuses the existing message. All three checks pass.
- Red/green: restoring the old exact-string check reproduces the same identity-conflict error as the VM. Before stored-message recovery, the fault-injection replay leaves the CRM link missing.
- The database checks use a disposable PGlite PostgreSQL-compatible instance with one connection. They are not a native PostgreSQL concurrency test. The larger existing reply-agent suite stalled in that fixture and is not counted as passed here.
- Production build: pass, using the Dockerfile's recorder packaging, recovery bundling and Node/webpack build steps with a 4,096 MB heap. The existing grid sandbox dynamic-dependency warning remains.
- Production standalone server (`bun server.js`): sign-in returns 200. The HTTP workspace-isolation walk passes with 132 reads, 21 writes and 66 pages, 0 isolation failures and 0 review items on this disposable fixture.
- Docker image build and real provider delivery: not performed here; the environment has no Docker daemon.

The code graph was regenerated locally. Its JSON exceeds the GitHub connector's 16 MiB input limit; the remote graph/report pair remains at the previous revision. Application code, tests, Docker packaging and this report are published together.

## Deploy and recover the controlled test recipient

Run on the VM, in `~/leads-x`:

```bash
(
set -euo pipefail
cd ~/leads-x
unset SKIP_GIT_UPDATE DEPLOY_REEXEC MIGRATIONS
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml:docker-compose.claude-code.yml
NEXT_BUILD_HEAP_MB=4096 bash docker/deploy.sh --branch codex/pilot-deploy-20261021
docker compose exec -T app agentsdr-entrypoint bun \
  scripts/recover-whatsapp-reply.bundle.js --phone +918084794983 --apply
docker inspect agentsdr-app-1 --format \
  'Revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
)
```

The recovery result should say `reply queued through the CRM` or `already linked`. A superseded message is deliberately not queued. Delivery is accepted only after a real reply is visible on the controlled recipient's phone and recorded in the app. That live acceptance remains pending.

## Existing report interpretation

The request's Interested count includes earlier applied interested classifications. It does not mean that the latest bare greeting was classified as interested. This fix does not reset historical interest or rewrite report definitions.
