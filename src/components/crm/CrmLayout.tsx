"use client";

import Link from "next/link";
import { RiArrowLeftLine, RiCheckboxCircleLine } from "@remixicon/react";
import * as AlignSelect from "@/components/alignui/select";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { cn } from "@/utils/cn";

/**
 * The CRM pages' frame: the Analytics page width and padding on a white page.
 * Each page draws its own PageHeader (its title, badges and actions depend on
 * what it loads), so `title` here is only for callers that have nothing else.
 * The Action required / Pipeline / Sequences tab bar that used to live here is
 * gone: the sidebar links to all three.
 */
export function CrmLayout({ children, title, description }: { children: React.ReactNode; title?: string; description?: string }) {
  return (
    <PageContainer>
      {title && <div className="mb-6"><PageHeader title={title} description={description} /></div>}
      {children}
    </PageContainer>
  );
}

export function DatabasePageHeader({ kind, title, description, count, actions }: { kind: "people" | "companies"; title: string; description: string; count: number; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-title-h5 text-text-strong-950">{title}</h1>
        <p className="mt-1 max-w-2xl text-paragraph-sm text-text-sub-600">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-9 items-center rounded-lg bg-bg-white-0 px-3 text-label-sm text-text-sub-600 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200"><strong className="mr-1 text-text-strong-950">{count.toLocaleString()}</strong> {kind}</span>
        {actions}
      </div>
    </div>
  );
}

export function CrmCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-xl bg-bg-white-0 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200", className)}>{children}</section>;
}

export function CrmCardHeader({ title, detail, action }: { title: React.ReactNode; detail?: string; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stroke-soft-200 px-4 py-3.5 sm:px-5"><div><h2 className="text-label-md text-text-strong-950">{title}</h2>{detail && <p className="mt-0.5 text-paragraph-xs text-text-sub-600">{detail}</p>}</div>{action}</div>;
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return <div className="px-5 py-14 text-center"><span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-bg-weak-50 text-text-soft-400"><RiCheckboxCircleLine className="size-5" aria-hidden="true" /></span><p className="text-label-sm text-text-strong-950">{title}</p>{detail && <p className="mx-auto mt-1 max-w-md text-paragraph-sm text-text-sub-600">{detail}</p>}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div role="alert" className="rounded-xl bg-error-lighter px-4 py-3 text-paragraph-sm text-error-dark ring-1 ring-inset ring-error-light"><p>{message}</p>{onRetry && <button type="button" className="mt-2 text-label-sm underline underline-offset-2" onClick={onRetry}>Try again</button>}</div>;
}

export function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="space-y-2 p-4" role="status" aria-label="Loading">{Array.from({ length: count }, (_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-bg-weak-50" />)}<span className="sr-only">Loading content</span></div>;
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "success" | "info" | "danger" | "warning" }) {
  const styles = { neutral: "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200", success: "bg-success-lighter text-success-dark ring-success-light", info: "bg-information-lighter text-information-dark ring-information-light", danger: "bg-error-lighter text-error-dark ring-error-light", warning: "bg-warning-lighter text-warning-dark ring-warning-light" };
  return <span className={cn("inline-flex h-5 items-center rounded-md px-2 text-label-xs capitalize ring-1 ring-inset", styles[tone])}>{children}</span>;
}

export function Select({ label, value, onChange, children, className, ariaLabel }: { label?: string; value: string; onChange: (value: string) => void; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  return <label className={cn("block text-paragraph-sm", className)}>{label && <span className="mb-1.5 block text-label-xs text-text-sub-600">{label}</span>}<AlignSelect.Root size="small" value={value} onValueChange={onChange}><AlignSelect.Trigger aria-label={!label ? ariaLabel : undefined}><AlignSelect.Value /></AlignSelect.Trigger><AlignSelect.Content>{children}</AlignSelect.Content></AlignSelect.Root></label>;
}

/** An option of `Select` above. */
export const SelectOption = AlignSelect.Item;

export function BackLink({ href, children = "Back" }: { href: string; children?: React.ReactNode }) {
  return <Link href={href} className="mb-4 inline-flex items-center gap-1.5 text-label-sm text-text-sub-600 transition hover:text-text-strong-950"><RiArrowLeftLine className="size-4" aria-hidden="true" />{children}</Link>;
}

export const primaryButtonClass = "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary-base px-3 text-label-sm text-primary-contrast transition hover:bg-primary-darker focus-visible:outline-none focus-visible:shadow-button-primary-focus disabled:pointer-events-none disabled:bg-bg-weak-50 disabled:text-text-disabled-300";
export const secondaryButtonClass = "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-bg-white-0 px-3 text-label-sm text-text-sub-600 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:outline-none focus-visible:shadow-button-important-focus disabled:pointer-events-none disabled:bg-bg-weak-50 disabled:text-text-disabled-300";
export const subtleButtonClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-label-sm text-text-sub-600 transition hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:outline-none focus-visible:shadow-button-important-focus disabled:pointer-events-none disabled:text-text-disabled-300";
export const dangerButtonClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-bg-white-0 px-2.5 text-label-sm text-error-base ring-1 ring-inset ring-error-light transition hover:bg-error-lighter focus-visible:outline-none focus-visible:shadow-button-error-focus disabled:pointer-events-none disabled:text-text-disabled-300";
export const fieldClass = "w-full rounded-lg bg-bg-white-0 px-3 py-2 text-paragraph-sm text-text-strong-950 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition placeholder:text-text-soft-400 hover:bg-bg-weak-50 focus:bg-bg-white-0 focus:shadow-button-important-focus focus:ring-stroke-strong-950 disabled:bg-bg-weak-50 disabled:text-text-disabled-300";
