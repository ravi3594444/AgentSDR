"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import { RiDeleteBinLine, RiLoader4Line, RiPencilLine, RiUpload2Line } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import { FormError, TextField } from "@/components/calls/fields";
import { errorMessage } from "@/components/crm/crm-utils";
import { Avatar } from "@/components/calling/callingShared";
import { CompanyNameField } from "@/components/calling/CompanyNameField";
import { updateCampaignContactPerson, uploadContactPhoto } from "@/lib/calls/client";
import { MAX_PHOTO_BYTES, type CampaignContact } from "@/lib/calls/contract";
import { BRAND } from "@/lib/brand";

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Only an https link can be typed into the "Photo link" field; an uploaded photo is served from our own path. */
function linkOf(url: string | null): string {
  return url && /^https:\/\//i.test(url) ? url : "";
}

/**
 * Edits the lead's People record, photo included. An upload or a photo
 * removal takes effect at once (and is reported through onContactChanged);
 * everything else waits for Save.
 */
export function EditContactModal({
  open,
  onOpenChange,
  contact,
  onSaved,
  onContactChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: CampaignContact;
  /** The rest of the form was saved. */
  onSaved: () => void;
  /** The photo was uploaded or removed, with the contact as the server now has it. */
  onContactChanged?: (contact: CampaignContact) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [photoLink, setPhotoLink] = useState("");
  const [savedLink, setSavedLink] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState<"upload" | "remove" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // Reset when the modal opens (or is pointed at another contact) — not on
  // every contact refresh, which a photo upload triggers and must not wipe the draft.
  useEffect(() => {
    if (open) {
      const person = contact.person;
      setFullName(person.fullName ?? "");
      setPhone(person.phone ?? "");
      setCompanyName(person.companyName ?? "");
      setCompanyWebsite(person.companyWebsite ?? "");
      setTitle(person.title ?? "");
      setEmail(person.email ?? "");
      setPhotoLink(linkOf(person.profilePictureUrl));
      setSavedLink(linkOf(person.profilePictureUrl));
      setPhotoUrl(person.profilePictureUrl);
      setError("");
      setSubmitting(false);
      setPhotoBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact.id]);

  const busy = submitting || photoBusy !== null;
  const name = fullName.trim() || contact.person.fullName || contact.person.firstName || "Unnamed contact";
  const typedLink = photoLink.trim();
  const previewUrl = /^https:\/\//i.test(typedLink) && typedLink !== savedLink ? typedLink : photoUrl;

  const upload = async (file: File) => {
    if (!PHOTO_TYPES.includes(file.type)) {
      setError("Choose a JPG, PNG, WebP or GIF image.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError(`That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`);
      return;
    }
    setError("");
    setPhotoBusy("upload");
    try {
      const updated = await uploadContactPhoto(contact.id, file);
      setPhotoUrl(updated.person.profilePictureUrl);
      setPhotoLink("");
      setSavedLink("");
      onContactChanged?.(updated);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPhotoBusy(null);
    }
  };

  const removePhoto = async () => {
    setError("");
    setPhotoBusy("remove");
    try {
      const updated = await updateCampaignContactPerson(contact.id, { profilePictureUrl: null });
      setPhotoUrl(updated.person.profilePictureUrl);
      setPhotoLink("");
      setSavedLink("");
      onContactChanged?.(updated);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPhotoBusy(null);
    }
  };

  const submit = async () => {
    if (!fullName.trim() || !phone.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await updateCampaignContactPerson(contact.id, {
        fullName: fullName.trim(),
        phone: phone.trim(),
        companyName: companyName.trim() || null,
        companyWebsite: companyWebsite.trim() || null,
        title: title.trim() || null,
        email: email.trim() || null,
        // Sent only when the link was touched, so an uploaded photo is never overwritten by a stale field.
        ...(typedLink !== savedLink ? { profilePictureUrl: typedLink || null } : {}),
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Modal.Content>
        <Modal.Header icon={RiPencilLine}>
          <Modal.Title>Edit contact</Modal.Title>
          <Modal.Description>Edits the People record — shared everywhere this person appears in {BRAND.shortName}.</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-3">
          {error && <FormError>{error}</FormError>}
          <div className="flex items-center gap-3">
            <div className="relative">
              <Avatar name={name} src={previewUrl} className="size-14 text-label-md" />
              {photoBusy && (
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-bg-white-0/70">
                  <RiLoader4Line className="size-5 animate-spin text-text-sub-600" aria-hidden="true" />
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  event.target.value = "";
                  if (chosen) void upload(chosen);
                }}
              />
              <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Button.Icon as={RiUpload2Line} />
                {photoBusy === "upload" ? "Uploading…" : "Upload photo"}
              </Button.Root>
              {(photoUrl || typedLink) && (
                <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={() => void removePhoto()}>
                  <Button.Icon as={RiDeleteBinLine} />
                  {photoBusy === "remove" ? "Removing…" : "Remove photo"}
                </Button.Root>
              )}
              <p className="w-full text-paragraph-xs text-text-soft-400">JPG, PNG, WebP or GIF, up to {Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.</p>
            </div>
          </div>
          <TextField label="Photo link (optional)" value={photoLink} onChange={setPhotoLink} placeholder="https://…" disabled={busy} />
          <TextField label="Full name" autoFocus value={fullName} onChange={setFullName} disabled={busy} />
          <TextField label="WhatsApp number" value={phone} onChange={setPhone} disabled={busy} />
          <div className="grid gap-3 sm:grid-cols-2">
            <CompanyNameField
              label="Company name (optional)"
              value={companyName}
              onChange={setCompanyName}
              onPick={(company) => { setCompanyName(company.name ?? companyName); setCompanyWebsite(company.domain); }}
              disabled={busy}
            />
            <TextField label="Company website (optional)" value={companyWebsite} onChange={setCompanyWebsite} placeholder="acme.com" disabled={busy} />
          </div>
          <TextField label="Title (optional)" value={title} onChange={setTitle} disabled={busy} />
          <TextField label="Email (optional)" value={email} onChange={setEmail} disabled={busy} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button.Root variant="neutral" mode="stroke" size="small" disabled={busy}>Cancel</Button.Root>
          </Modal.Close>
          <Button.Root variant="primary" mode="filled" size="small" disabled={busy || !fullName.trim() || !phone.trim()} onClick={() => void submit()}>
            {submitting ? "Saving…" : "Save changes"}
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
