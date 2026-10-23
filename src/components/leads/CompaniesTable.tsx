"use client";

import { RiExternalLinkLine, RiFileCopyLine, RiGlobalLine, RiLinkedinBoxFill, RiMore2Line, RiSearchEyeLine, RiTeamLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Table from "@/components/alignui/table";
import * as Tooltip from "@/components/alignui/tooltip";
import { CHANNEL_META } from "@/components/analytics/theme";
import { cn } from "@/utils/cn";
import { Bar, Blob, CampaignSummary, CompanyFavicon, LinkIcon, stop, TwoLine } from "./LeadCells";
import { cellClass, fixedTableStyle, SortableHead } from "./SortableHead";
import { linkedInCompanyHref, shortDate, type CompanyRow, type Direction } from "./leadTypes";
import { MobileLeadCards } from "./MobileLeadCards";

const rowCell = cn(cellClass, "h-14");

function SkeletonRow({ index }: { index: number }) {
  const wide = ["w-28", "w-36", "w-24", "w-32"][index % 4];
  return (
    <Table.Row aria-hidden="true">
      <Table.Cell className={rowCell}><div className="flex items-center gap-3"><Blob className="size-8 rounded-lg" /><div className="space-y-2"><Bar className={wide} /><Bar className="h-2 w-20" /></div></div></Table.Cell>
      <Table.Cell className={rowCell}><Bar className="ml-auto w-6" /></Table.Cell>
      <Table.Cell className={rowCell}><div className="flex items-center gap-2"><Blob className="size-5 rounded-full" /><Bar className={wide} /></div></Table.Cell>
      <Table.Cell className={rowCell}><div className="flex gap-2.5"><Blob className="size-4 rounded" /><Blob className="size-4 rounded" /></div></Table.Cell>
      <Table.Cell className={rowCell}><Bar className="w-14" /></Table.Cell>
      <Table.Cell className={rowCell} />
    </Table.Row>
  );
}

function CompanyTableRow({ row, onOpen, onResearch }: { row: CompanyRow; onOpen: (row: CompanyRow) => void; onResearch?: (row: CompanyRow) => void }) {
  const { company, peopleCount, campaigns } = row;
  const name = company.name || company.domain;
  const linkedin = company.linkedinUrl ? linkedInCompanyHref(company.linkedinUrl) : null;
  const open = () => onOpen(row);
  return (
    <Table.Row
      tabIndex={0}
      aria-label={`Show people at ${name}`}
      onClick={open}
      onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") open(); }}
      className="cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50"
    >
      <Table.Cell className={rowCell}>
        <div className="flex min-w-0 items-center gap-3">
          <CompanyFavicon domain={company.domain} />
          <TwoLine primary={name} primaryTitle={name} secondary={company.name && company.name !== company.domain ? company.domain : null} />
        </div>
      </Table.Cell>
      <Table.Cell className={cn(rowCell, "text-right text-paragraph-sm tabular-nums", peopleCount ? "text-text-strong-950" : "text-text-soft-400")}>{peopleCount.toLocaleString("en-US")}</Table.Cell>
      <Table.Cell className={rowCell}><CampaignSummary campaigns={campaigns} /></Table.Cell>
      <Table.Cell className={rowCell}>
        <div className="-ml-1.5 flex items-center gap-0.5">
          <LinkIcon href={`https://${company.domain}`} label="website" icon={RiGlobalLine} />
          <LinkIcon href={linkedin} label="LinkedIn page" icon={RiLinkedinBoxFill} color={CHANNEL_META.linkedin.color} />
        </div>
      </Table.Cell>
      <Table.Cell className={cn(rowCell, "whitespace-nowrap text-paragraph-sm tabular-nums text-text-sub-600")}>{shortDate(company.updatedAt)}</Table.Cell>
      <Table.Cell className={cn(rowCell, "pl-0 pr-2")} onClick={stop} onKeyDown={stop}>
        <div className="flex justify-end">
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label={`More actions for ${name}`}><Button.Icon as={RiMore2Line} /></Button.Root>
            </Dropdown.Trigger>
            <Dropdown.Content>
              <Dropdown.Item onSelect={open}><Dropdown.ItemIcon as={RiTeamLine} />Show people</Dropdown.Item>
              {onResearch && <Dropdown.Item onSelect={() => onResearch(row)}><Dropdown.ItemIcon as={RiSearchEyeLine} />Research company</Dropdown.Item>}
              <Dropdown.Item onSelect={() => window.open(`https://${company.domain}`, "_blank", "noopener,noreferrer")}><Dropdown.ItemIcon as={RiExternalLinkLine} />Open website</Dropdown.Item>
              {linkedin && <Dropdown.Item onSelect={() => window.open(linkedin, "_blank", "noopener,noreferrer")}><Dropdown.ItemIcon as={RiLinkedinBoxFill} />Open LinkedIn page</Dropdown.Item>}
              <Dropdown.Item onSelect={() => void navigator.clipboard?.writeText(company.domain)}><Dropdown.ItemIcon as={RiFileCopyLine} />Copy domain</Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Root>
        </div>
      </Table.Cell>
    </Table.Row>
  );
}

export function CompaniesTable({ rows, sort, direction, onSort, loading, onOpen, onResearch }: {
  rows: CompanyRow[] | null;
  sort: string;
  direction: Direction;
  onSort: (key: string) => void;
  loading: boolean;
  /** A row click: the People tab, searched to this company. */
  onOpen: (row: CompanyRow) => void;
  /** The row menu's "Research company": web research about it. */
  onResearch?: (row: CompanyRow) => void;
}) {
  const head = { activeSort: sort, direction, onSort };
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={300} disableHoverableContent>
      <MobileLeadCards kind="companies" rows={rows} loading={loading} onOpen={onOpen} onResearch={onResearch} />
      <Table.Root style={fixedTableStyle} className="hidden md:block">
        <Table.Header>
          <tr>
            <SortableHead label="Company" sortKey="name" className="w-[26%]" {...head} />
            <SortableHead label="People" sortKey="people" className="w-24 text-right" {...head} />
            <SortableHead label="Outreach" />
            <SortableHead label="Links" className="w-28" />
            <SortableHead label="Updated" sortKey="updated" className="w-32" {...head} />
            <SortableHead label={<span className="sr-only">Actions</span>} className="w-12" />
          </tr>
        </Table.Header>
        <Table.Body spacing={4} className={cn("transition-opacity", loading && rows && "opacity-60")} aria-busy={loading}>
          {rows === null ? Array.from({ length: 10 }, (_, index) => <SkeletonRow key={index} index={index} />) : rows.map((row) => <CompanyTableRow key={row.company.id} row={row} onOpen={onOpen} onResearch={onResearch} />)}
        </Table.Body>
      </Table.Root>
    </Tooltip.Provider>
  );
}
