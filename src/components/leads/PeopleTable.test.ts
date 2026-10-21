import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Leads > People named every nameless row "Unnamed person", even a business
// discovery saved with its published name. The row's label now comes from
// leadLabel (src/lib/leads/displayName.ts, tested there); this checks the
// table uses it rather than its own fallback.

const source = readFileSync(join(import.meta.dir, "PeopleTable.tsx"), "utf8");

describe("PeopleTable names a row through leadLabel", () => {
  test("the label, its line and the avatar come from leadLabel, not person.fullName alone", () => {
    expect(source).toContain("leadLabel(person, company)");
    expect(source).not.toContain('person.fullName || "Unnamed person"');
    expect(source).toContain("secondary={secondary}");
    expect(source).not.toContain("initials(person.fullName)");
  });

  test("a business without a companies row shows the company the save path kept, instead of a dash", () => {
    expect(source).toMatch(/keptCompany \? <TwoLine primary=\{keptCompany\}/);
  });

  test("the table writes nothing: no fetch, no form, only navigation and copy", () => {
    expect(source).not.toMatch(/fetch\(|method\s*:/);
  });
});
