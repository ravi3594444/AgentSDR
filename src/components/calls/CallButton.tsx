"use client";

import Link from "next/link";
import { useState } from "react";
import { RiArrowDownSLine, RiLoader4Line, RiPhoneLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Modal from "@/components/alignui/modal";
import { DocsLink } from "@/components/page/DocsLink";
import { MIN_RECORDER_VERSION } from "@/lib/calls/contract";
import type { DocsPage } from "@/lib/support";
import { RECORDER_SETUP_PATH } from "@/lib/calls/recorderRelease";
import { abandonCall, isRecorderInstalled, isRecorderOutdated, recorderVersion, sendToRecorder, startCall } from "@/lib/calls/client";
import { cn } from "@/utils/cn";
import { isReleased } from "@/lib/release";
import { errorMessage } from "@/components/crm/crm-utils";
import { FormError, TextField } from "./fields";

type Phase = "idle" | "starting" | "opening";

function CallButtonInner({ personId, crmRecordId, campaignContactId, phone, onCallStarted, numberMenu = true }: {
  personId: string;
  crmRecordId?: string | null;
  /** The Calling-section contact this call is placed from, when there is one. */
  campaignContactId?: string | null;
  phone: string | null;
  onCallStarted?: (callId: string) => void;
  /** Show the dropdown arrow with "Change number". Default true. */
  numberMenu?: boolean;
}) {
  // Anything that is not about the number itself — no extension, an
  // outdated one, the extension refusing — is a notice, not the number modal:
  // opening "Change number" for those sends the rep fixing the wrong thing.
  /** `download`: the fix is getting the extension, so the notice links to it (and `guide`, our docs on it). */
  const [notice, setNotice] = useState<{ title: string; description: string; download?: boolean; guide?: { page: DocsPage; label: string } } | null>(null);
  const [numberOpen, setNumberOpen] = useState(false);
  const [numberValue, setNumberValue] = useState("");
  const [modalError, setModalError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const busy = phase !== "idle";

  const openNumberModal = (prefill: string) => {
    setNumberValue(prefill);
    setModalError("");
    setNumberOpen(true);
  };

  const failed = (title: string, cause: unknown) => {
    setNumberOpen(false);
    setNotice({ title, description: errorMessage(cause) });
    setPhase("idle");
  };

  const begin = async (newPhone?: string) => {
    const clickedAt = Date.now();
    setModalError("");
    setPhase("starting");
    try {
      // Only send `phone` when the rep gave or corrected one here — the
      // contract treats it as an override, and a person who already has a
      // stored number should keep dialing that one untouched.
      const response = await startCall({
        personId,
        crmRecordId: crmRecordId ?? null,
        campaignContactId: campaignContactId ?? null,
        ...(newPhone ? { phone: newPhone } : {}),
      });
      try {
        const reply = await sendToRecorder({
          type: "call:start",
          callId: response.call.id,
          phone: response.call.phone,
          recorderToken: response.recorderToken,
          lead: response.lead,
          clickedAt,
        });
        if (reply.type === "call:accepted") {
          setNumberOpen(false);
          setPhase("opening");
          onCallStarted?.(response.call.id);
          // Give the rep a moment of confirmation before the button resets —
          // the extension takes over from here, opening WhatsApp itself.
          setTimeout(() => setPhase("idle"), 1500);
        } else {
          // This button only ever sends "call:start", so the reply is really
          // always "call:accepted" | "call:rejected" — the message:* branch
          // is unreachable but keeps this exhaustive against the bridge's
          // now-wider reply type.
          const error = reply.type === "call:rejected" ? reply.error : "Something went wrong. Please try again.";
          void abandonCall(response.call.id, response.recorderToken, error);
          failed("The call recorder couldn't start the call", new Error(error));
        }
      } catch (cause) {
        void abandonCall(response.call.id, response.recorderToken, errorMessage(cause));
        failed("The call recorder didn't answer", cause);
      }
    } catch (cause) {
      // A number the rep just typed was rejected: keep them in the modal to
      // fix it. Otherwise the problem is not one the number modal can solve.
      if (newPhone !== undefined) {
        setModalError(errorMessage(cause));
        setNumberOpen(true);
        setPhase("idle");
      } else {
        failed("Couldn't start the call", cause);
      }
    }
  };

  /** Installed and new enough to speak this page's bridge protocol. */
  const recorderReady = (): boolean => {
    if (!isRecorderInstalled()) {
      setNotice({
        title: "Call recorder not found",
        description: "Install the AgentSDR Call Recorder extension to call from here.",
        download: true,
        guide: { page: "whatsapp/calling#install-the-extension", label: "How to install" },
      });
      return false;
    }
    const version = recorderVersion();
    if (isRecorderOutdated(version)) {
      setNotice({
        title: "Reload the call recorder",
        description: `Chrome is running version ${version ?? "unknown"} of the extension; this page needs ${MIN_RECORDER_VERSION} or newer. Download the latest, replace the extension's folder with it, then click the reload arrow on AgentSDR Call Recorder in chrome://extensions and reload this page.`,
        download: true,
        guide: { page: "whatsapp/calling#update-the-extension", label: "How to update" },
      });
      return false;
    }
    return true;
  };

  const handleCallClick = () => {
    if (!recorderReady()) return;
    if (!phone) { openNumberModal(""); return; }
    void begin();
  };

  const handleChangeNumber = () => {
    if (!recorderReady()) return;
    openNumberModal(phone ?? "");
  };

  const label = phase === "starting" ? "Calling…" : phase === "opening" ? "Opening WhatsApp…" : "Call";

  return (
    <>
      <div className="inline-flex">
        <Button.Root
          variant="neutral"
          mode="stroke"
          size="xxsmall"
          disabled={busy}
          onClick={handleCallClick}
          className={cn("gap-1.5 whitespace-nowrap px-2.5 text-label-xs", phone && numberMenu && "rounded-r-none")}
        >
          {busy
            ? <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
            : <RiPhoneLine className="size-3.5" aria-hidden="true" />}
          {label}
        </Button.Root>
        {/* A number is already known — the button above dials it directly.
            Changing it is secondary, so it hides behind a split-button
            dropdown rather than a second always-visible control. */}
        {phone && numberMenu && (
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <Button.Root
                variant="neutral"
                mode="stroke"
                size="xxsmall"
                disabled={busy}
                aria-label="Call options"
                title={`Calling ${phone}`}
                className="-ml-px w-6 shrink-0 rounded-l-none px-0"
              >
                <RiArrowDownSLine className="size-3.5" aria-hidden="true" />
              </Button.Root>
            </Dropdown.Trigger>
            <Dropdown.Content align="end">
              <Dropdown.Item onSelect={handleChangeNumber}>Change number</Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Root>
        )}
      </div>

      <Modal.Root open={notice !== null} onOpenChange={(open) => { if (!open) setNotice(null); }}>
        <Modal.Content>
          <Modal.Header icon={RiPhoneLine}>
            <Modal.Title>{notice?.title}</Modal.Title>
            <Modal.Description>{notice?.description}</Modal.Description>
          </Modal.Header>
          <Modal.Footer>
            {notice?.guide && <DocsLink page={notice.guide.page}>{notice.guide.label}</DocsLink>}
            {notice?.download && (
              <Button.Root asChild variant="neutral" mode="stroke" size="small">
                <Link href={RECORDER_SETUP_PATH} onClick={() => setNotice(null)}>Get the extension</Link>
              </Button.Root>
            )}
            <Modal.Close asChild>
              <Button.Root variant="primary" mode="filled" size="small">Got it</Button.Root>
            </Modal.Close>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>

      <Modal.Root open={numberOpen} onOpenChange={(open) => { if (!busy) setNumberOpen(open); }}>
        <Modal.Content>
          <Modal.Header icon={RiPhoneLine}>
            <Modal.Title>{phone ? "Change WhatsApp number" : "Add a WhatsApp number"}</Modal.Title>
            <Modal.Description>The call places through WhatsApp Web to this number.</Modal.Description>
          </Modal.Header>
          <Modal.Body className="space-y-3">
            {modalError && <FormError>{modalError}</FormError>}
            <TextField label="WhatsApp number" autoFocus value={numberValue} onChange={setNumberValue} placeholder="+91 98765 43210" disabled={busy} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Close asChild>
              <Button.Root variant="neutral" mode="stroke" size="small" disabled={busy}>Cancel</Button.Root>
            </Modal.Close>
            <Button.Root
              variant="primary"
              mode="filled"
              size="small"
              disabled={busy || !numberValue.trim()}
              onClick={() => void begin(numberValue.trim())}
            >
              {busy
                ? <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                : <RiPhoneLine className="size-4" aria-hidden="true" />}
              {label}
            </Button.Root>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}

/** Nothing while calling is not part of this release (src/lib/release.ts). */
export function CallButton(props: Parameters<typeof CallButtonInner>[0]) {
  return isReleased("calling") ? <CallButtonInner {...props} /> : null;
}
