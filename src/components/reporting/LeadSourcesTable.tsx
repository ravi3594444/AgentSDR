import { METRICS, type LeadSources } from "@/lib/reporting/metrics";

/**
 * Qualified and contactable people per source and provider ("Google Maps
 * through the built-in scraper"), with a total that counts each person once
 * and the people more than one source found, listed with every source.
 * Overview and Analytics show the same table from the same figures
 * (src/lib/reporting/metrics.server.ts leadSources).
 */
export function LeadSourcesTable({ sources, empty }: { sources: LeadSources; empty: string }) {
  if (!sources.rows.length) return <p className="text-paragraph-xs text-text-soft-400">{empty}</p>;
  const { multiSource, total } = sources;
  return (
    <div className="min-w-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-left text-paragraph-xs">
          <caption className="sr-only">Leads per source and provider</caption>
          <thead>
            <tr className="text-text-soft-400">
              <th scope="col" className="py-1 pr-3 font-normal">Source</th>
              <th scope="col" className="pr-3 text-right font-normal" title={METRICS.foundLeads.definition}>Found</th>
              <th scope="col" className="pr-3 text-right font-normal" title={METRICS.qualifiedLeads.definition}>Qualified</th>
              <th scope="col" className="text-right font-normal" title={METRICS.contactableLeads.definition}>Contactable</th>
            </tr>
          </thead>
          <tbody>
            {sources.rows.map((row) => (
              <tr key={row.key} className="border-t border-stroke-soft-200 text-text-strong-950">
                <td className="py-1.5 pr-3">
                  {row.label}
                  {row.alsoFoundElsewhere > 0 && <span className="block text-text-soft-400">{row.alsoFoundElsewhere} also found by another source</span>}
                </td>
                <td className="pr-3 text-right tabular-nums">{row.found}</td>
                <td className="pr-3 text-right tabular-nums">{row.qualified}</td>
                <td className="text-right tabular-nums">{row.contactable}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-stroke-sub-300 text-text-strong-950">
              <th scope="row" className="py-1.5 pr-3 font-medium">All sources, each person once</th>
              <td className="pr-3 text-right font-medium tabular-nums">{total.found}</td>
              <td className="pr-3 text-right font-medium tabular-nums">{total.qualified}</td>
              <td className="text-right font-medium tabular-nums">{total.contactable}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {multiSource.people > 0 && (
        <div className="mt-3 text-paragraph-xs text-text-sub-600">
          <p>
            {multiSource.people} {multiSource.people === 1 ? "person was" : "people were"} found by more than one source: counted once in the total, listed under each source.
          </p>
          {multiSource.examples.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {multiSource.examples.map((example, index) => (
                <li key={`${example.name}-${index}`}>
                  <span className="text-text-strong-950">{example.name}</span> — {example.sources.join("; ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="mt-2 text-paragraph-xs text-text-soft-400">
        Qualified: saved as a lead (an open business or profile that matched). Contactable: with an open contact route and not Do Not Contact. Neither confirms delivery or interest.
      </p>
    </div>
  );
}
