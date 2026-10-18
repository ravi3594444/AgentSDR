/**
 * Plain text from the small HTML fragments the source APIs return (a Hacker
 * News comment, a Stack Exchange question body, an entity-encoded title):
 * paragraphs and list items kept as lines, other tags dropped, entities
 * decoded. Pure, and linear on any input.
 */

const MAX_HTML = 100_000;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

/** One pass, so "&amp;lt;" becomes "&lt;", not "<". Unknown or invalid entities stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** Tags that end a line; "p" and "pre" leave a blank line; "li" starts a "- " line. */
const LINE_BREAK = new Set(["br", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "table", "hr"]);
const PARAGRAPH = new Set(["p", "pre"]);

export function htmlToText(html: string, maxLength = 20_000): string {
  const source = html.slice(0, MAX_HTML);
  let out = "";
  let at = 0;
  for (;;) {
    const lt = source.indexOf("<", at);
    if (lt < 0) break;
    const gt = source.indexOf(">", lt + 1);
    // No ">" after this "<": none after any later "<" either.
    if (gt < 0) break;
    out += source.slice(at, lt);
    const tag = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(source.slice(lt + 1, Math.min(gt, lt + 16)));
    if (!tag) {
      // "< 3" or "<>" is text, not a tag.
      out += source.slice(lt, gt + 1);
    } else {
      const name = tag[2]!.toLowerCase();
      const closing = tag[1] === "/";
      if (name === "li") out += closing ? "" : "\n- ";
      else if (PARAGRAPH.has(name)) out += "\n\n";
      else if (LINE_BREAK.has(name)) out += "\n";
    }
    at = gt + 1;
  }
  out += source.slice(at);
  const text = decodeEntities(out)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** A one-line excerpt: whitespace collapsed, cut at `max` characters. */
export function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The text cut at `max` characters, lines kept. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
