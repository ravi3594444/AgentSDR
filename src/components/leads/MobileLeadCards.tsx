"use client";

import Link from "next/link";
import { RiArrowRightLine, RiExternalLinkLine, RiFileCopyLine, RiMore2Line, RiSearchEyeLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { companyName as savedCompanyName, leadLabel } from "@/lib/leads/displayName";
import { CampaignSummary, CompanyFavicon, CrmSummary, ReachIcons } from "./LeadCells";
import { initials, linkedInCompanyHref, linkedInPersonHref, shortDate, type CompanyRow, type PersonRow } from "./leadTypes";
import { cn } from "@/utils/cn";

const card = "min-w-0 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4";
const action = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-label-sm text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 outline-none hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base";

type Props = { loading: boolean } & (
  | { kind: "people"; rows: PersonRow[] | null }
  | { kind: "companies"; rows: CompanyRow[] | null; onOpen: (row: CompanyRow) => void; onResearch?: (row: CompanyRow) => void }
);

/** The same loaded page of leads, presented as readable cards on a phone. */
export function MobileLeadCards(props: Props) {
  if (!props.rows) return <div className="space-y-3 md:hidden" role="status" aria-label="Loading leads">{Array.from({ length: 5 }, (_, index) => <div key={index} className={cn(card, "space-y-3")}><div className="h-5 w-2/3 animate-pulse rounded bg-bg-weak-50" /><div className="h-4 w-1/2 animate-pulse rounded bg-bg-weak-50" /><div className="h-11 animate-pulse rounded bg-bg-weak-50" /></div>)}</div>;
  return <ul aria-label={props.kind === "people" ? "People" : "Companies"} aria-busy={props.loading} className={cn("space-y-3 md:hidden", props.loading && "opacity-60")}>
    {props.kind === "people"
      ? props.rows.map(row => <li key={row.person.id}><PersonCard row={row} /></li>)
      : props.rows.map(row => <li key={row.company.id}><CompanyCard row={row} onOpen={props.onOpen} onResearch={props.onResearch} /></li>)}
  </ul>;
}

function PersonCard({ row }: { row: PersonRow }) {
  const { person, company, crm } = row;
  const label = leadLabel(person, company);
  const href = crm ? `/crm/records/${crm.recordId}` : null;
  const companyLabel = company?.name || company?.domain || savedCompanyName(person, null) || label.secondary;
  return <article className={card}>
    <div className="flex items-start gap-3">
      <ContactAvatar src={person.profilePictureUrl} fallback={initials(label.kind === "unknown" ? null : label.name)} className="size-10 shrink-0 bg-bg-weak-50 text-text-sub-600" />
      <div className="min-w-0 flex-1">
        <h2 className="text-label-md text-text-strong-950 [overflow-wrap:anywhere]">{href ? <Link href={href} className="hover:underline">{label.name}</Link> : label.name}</h2>
        {companyLabel && companyLabel !== label.name && <p className="mt-1 text-paragraph-sm text-text-sub-600 [overflow-wrap:anywhere]">{companyLabel}</p>}
        {person.title && label.kind === "person" && <p className="mt-1 text-paragraph-xs text-text-sub-600">{person.title}</p>}
      </div>
      <Dropdown.Root>
        <Dropdown.Trigger asChild><Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label={`More actions for ${label.name}`} className="size-11 shrink-0"><Button.Icon as={RiMore2Line} /></Button.Root></Dropdown.Trigger>
        <Dropdown.Content align="end">
          {href && <Dropdown.Item asChild><Link href={href}>Open CRM record</Link></Dropdown.Item>}
          {person.linkedinUrl && <Dropdown.Item asChild><a href={linkedInPersonHref(person.linkedinUrl)} target="_blank" rel="noopener noreferrer"><Dropdown.ItemIcon as={RiExternalLinkLine} />Open LinkedIn profile</a></Dropdown.Item>}
          {person.email && <Dropdown.Item onSelect={() => void navigator.clipboard?.writeText(person.email!)}><Dropdown.ItemIcon as={RiFileCopyLine} />Copy email</Dropdown.Item>}
          {person.phone && <Dropdown.Item onSelect={() => void navigator.clipboard?.writeText(person.phone!)}><Dropdown.ItemIcon as={RiFileCopyLine} />Copy phone</Dropdown.Item>}
          {!href && !person.linkedinUrl && !person.email && !person.phone && <p className="p-2 text-paragraph-sm text-text-sub-600">No actions available</p>}
        </Dropdown.Content>
      </Dropdown.Root>
    </div>
    {(person.email || person.phone) && <div className="mt-3 space-y-1 text-paragraph-sm text-text-sub-600 [overflow-wrap:anywhere]">{person.email && <p>{person.email}</p>}{person.phone && <p>{person.phone}</p>}</div>}
    <div className="mt-3 flex flex-wrap items-center gap-2 [&_button]:size-11 [&_a]:size-11"><ReachIcons person={person} /></div>
    <dl className="mt-3 grid min-w-0 grid-cols-2 gap-3 border-t border-stroke-soft-200 pt-3">
      <div className="min-w-0"><dt className="mb-2 text-paragraph-xs text-text-sub-600">Outreach</dt><dd><CampaignSummary campaigns={row.campaigns} /></dd></div>
      <div className="min-w-0"><dt className="mb-2 text-paragraph-xs text-text-sub-600">CRM</dt><dd><CrmSummary crm={crm} /></dd></div>
    </dl>
    {href && <Link href={href} className={cn(action, "mt-4 w-full")}>Open conversation<RiArrowRightLine className="size-4" aria-hidden="true" /></Link>}
  </article>;
}

function CompanyCard({ row, onOpen, onResearch }: { row: CompanyRow; onOpen: (row: CompanyRow) => void; onResearch?: (row: CompanyRow) => void }) {
  const { company, peopleCount, campaigns } = row;
  const name = company.name || company.domain;
  return <article className={card}>
    <div className="flex items-start gap-3">
      <CompanyFavicon domain={company.domain} className="size-10" />
      <div className="min-w-0 flex-1"><h2 className="text-label-md text-text-strong-950 [overflow-wrap:anywhere]"><button type="button" onClick={() => onOpen(row)} className="text-left hover:underline">{name}</button></h2><p className="mt-1 text-paragraph-sm text-text-sub-600 [overflow-wrap:anywhere]">{company.domain}</p></div>
      <Dropdown.Root>
        <Dropdown.Trigger asChild><Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label={`More actions for ${name}`} className="size-11 shrink-0"><Button.Icon as={RiMore2Line} /></Button.Root></Dropdown.Trigger>
        <Dropdown.Content align="end">
          <Dropdown.Item onSelect={() => onOpen(row)}>Show people</Dropdown.Item>
          {onResearch && <Dropdown.Item onSelect={() => onResearch(row)}><Dropdown.ItemIcon as={RiSearchEyeLine} />Research company</Dropdown.Item>}
          <Dropdown.Item asChild><a href={`https://${company.domain}`} target="_blank" rel="noopener noreferrer"><Dropdown.ItemIcon as={RiExternalLinkLine} />Open website</a></Dropdown.Item>
          {company.linkedinUrl && <Dropdown.Item asChild><a href={linkedInCompanyHref(company.linkedinUrl)} target="_blank" rel="noopener noreferrer">Open LinkedIn page</a></Dropdown.Item>}
          <Dropdown.Item onSelect={() => void navigator.clipboard?.writeText(company.domain)}><Dropdown.ItemIcon as={RiFileCopyLine} />Copy domain</Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Root>
    </div>
    <dl className="mt-4 grid grid-cols-2 gap-3"><div><dt className="text-paragraph-xs text-text-sub-600">People</dt><dd className="mt-1 text-label-md text-text-strong-950">{peopleCount.toLocaleString()}</dd></div><div className="min-w-0"><dt className="mb-2 text-paragraph-xs text-text-sub-600">Outreach</dt><dd><CampaignSummary campaigns={campaigns} /></dd></div></dl>
    <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => onOpen(row)} className={action}>Show people<RiArrowRightLine className="size-4" aria-hidden="true" /></button><a href={`https://${company.domain}`} target="_blank" rel="noopener noreferrer" className={action}>Website<RiExternalLinkLine className="size-4" aria-hidden="true" /></a>{onResearch && <button type="button" onClick={() => onResearch(row)} className={action}><RiSearchEyeLine className="size-4" aria-hidden="true" />Research</button>}</div>
    <p className="mt-3 text-paragraph-xs text-text-sub-600">Updated {shortDate(company.updatedAt)}</p>
  </article>;
}
