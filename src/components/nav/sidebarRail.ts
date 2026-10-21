/**
 * What the collapsed sidebar (the icon rail) says for an entry. Collapsed,
 * a count becomes a dot; the entry's accessible name and its tooltip carry
 * the number instead, so the rail still says what needs attention.
 */

/** "3 need attention" (999+ past that), or "" when nothing does. */
export function attentionText(count: number | null | undefined): string {
  if (!count || count <= 0) return "";
  return `${count > 999 ? "999+" : count.toLocaleString("en-US")} ${count === 1 ? "needs" : "need"} attention`;
}

/** "Inbox, 3 need attention", or just "Inbox". */
export function railLabel(label: string, count: number | null | undefined): string {
  const attention = attentionText(count);
  return attention ? `${label}, ${attention}` : label;
}
