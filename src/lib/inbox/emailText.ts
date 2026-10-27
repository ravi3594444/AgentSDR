const ATTRIBUTION = /^\s*On\b.{4,200}\bwrote:\s*$/i;
const ATTRIBUTION_START = /^\s*On\b.{4,200}$/i;
const WROTE_LINE = /^\s*(.{0,80}\s)?wrote:\s*$/i;
const FORWARD_MARK = /^\s*(-{2,}\s*(original message|forwarded message)\s*-{2,}|_{5,})\s*$/i;
const OUTLOOK_HEADER = /^\s*From:\s.+$/i;

/**
 * Splits an email body into what was written and the quoted history under
 * it: from an "On … wrote:" attribution (also wrapped over two lines), a
 * "----- Original Message -----" mark, an Outlook "From:/Sent:" block, or a
 * trailing run of "> " lines.
 */
export function splitQuoted(body: string): { main: string; quoted: string } {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let cut = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (ATTRIBUTION.test(line) || FORWARD_MARK.test(line)) {
      cut = i;
      break;
    }
    if (ATTRIBUTION_START.test(line) && WROTE_LINE.test(lines[i + 1] ?? "")) {
      cut = i;
      break;
    }
    if (OUTLOOK_HEADER.test(line) && /^\s*(Sent|Date):\s/i.test(lines[i + 1] ?? "")) {
      cut = i;
      break;
    }
  }
  if (cut < 0) {
    // A trailing block where every non-empty line is quoted.
    let start = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line.startsWith(">")) start = i;
      else break;
    }
    if (start < lines.length && lines.slice(start).some((line) => line.trim().startsWith(">"))) cut = start;
  }
  if (cut <= 0) return { main: body.trim(), quoted: "" };
  return { main: lines.slice(0, cut).join("\n").trim(), quoted: lines.slice(cut).join("\n").trim() };
}

