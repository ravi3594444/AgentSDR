import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { gridColumns, gridRows, gridTables } from "./schema";
import { inOrgTables } from "./scope";
import { effectiveColumnType } from "./value-types";
import { buildFormulaLookupRegistry, resolveFormulaConfig } from "./formula-lookups";
import { assertFormulaSyntax, evaluateOnce, excelOnlyOperator } from "./runners";
import type { CellValues } from "./types";

export class FormulaGeneratorUnavailableError extends Error {}

export async function generateFormula(tableId: string, request: string, currentExpression?: string) {
  const [currentTable] = await db.select().from(gridTables).where(and(inOrg(gridTables), eq(gridTables.id, tableId))).limit(1);
  if (!currentTable) throw new Error("Table not found");
  const tables = await db.select().from(gridTables).where(and(inOrg(gridTables), eq(gridTables.workbookId, currentTable.workbookId)));
  const columns = await db.select().from(gridColumns).where(inArray(gridColumns.tableId, tables.map((table) => table.id)));
  const schema = tables.map((table) => ({
    table: table.name,
    id: table.id,
    current: table.id === tableId,
    columns: columns.filter((column) => column.tableId === table.id).map((column) => ({
      name: column.name,
      key: column.key,
      type: effectiveColumnType(column),
    })),
  }));

  const sample = await sampleRow(tableId, schema.find((table) => table.current)?.columns ?? []);

  let feedback: string | undefined;
  let lastProblem = "";
  // One retry: the first miss is usually a stray Excel habit the error message fixes.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { formula, explanation } = await askModel(schema, request, currentExpression, feedback);
    const problem = await formulaProblem(tableId, formula, sample);
    if (!problem) return { formula, explanation: explanation || "Generated from your request." };
    lastProblem = problem;
    feedback = `Your previous formula was rejected.\nFormula: ${formula}\nProblem: ${problem}\nReturn a corrected formula.`;
  }
  throw new Error(`The AI could not produce a working formula (${lastProblem}). Try rephrasing the request.`);
}

const LANGUAGE_RULES = [
  "Generate one safe formula expression for a spreadsheet-like grid.",
  "The formula language is a single JavaScript expression, NOT Excel syntax.",
  "Join text with +  (or CONCATENATE / template literals). Never use & for text: in JavaScript it is bitwise AND and yields 0. Use !== for not-equal, never <>, and == / === for equality, never a lone =.",
  "Current-row columns MUST be referenced as {{stableKey}} using only keys from the current table; a token is replaced by the cell value as a JavaScript literal (null when empty), so guard empty cells, e.g. ({{name}} || \"\").",
  "Available globals: lodash as _, moment, and FormulaJS functions called by name, such as IF, AND, OR, CONCATENATE, SUM, ROUND, UPPER, LOWER, TEXT. Example: UPPER({{name}}) + \"-\" + {{domain}}",
  'For another table use LOOKUP("Table name", {{currentRowKey}}, "Lookup column name", "Return column name") exactly. It returns the first exact match or null. An optional fifth argument is the default value.',
  "LOOKUP table and column arguments must be quoted literal names from the supplied schema.",
  "Return an expression only in formula; do not include markdown, a leading equals sign, assignments, statements, network calls, or explanations inside it.",
].join("\n");

async function askModel(
  schema: unknown,
  request: string,
  currentExpression: string | undefined,
  feedback: string | undefined,
): Promise<{ formula: string; explanation: string }> {
  let result: Awaited<ReturnType<typeof completeStructured>>;
  try {
    result = await completeStructured({
      timeoutMs: 30_000,
      systemPrompt: LANGUAGE_RULES,
      userPrompt: `Workbook schema:\n${JSON.stringify(schema)}\n\nUser request:\n${request}${currentExpression ? `\n\nCurrent formula to improve:\n${currentExpression}` : ""}${feedback ? `\n\n${feedback}` : ""}`,
      maxOutputTokens: 800,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["formula", "explanation"],
        properties: {
          formula: { type: "string" },
          explanation: { type: "string" },
        },
      },
      schemaName: "generate_formula",
    });
  } catch (error) {
    throw new FormulaGeneratorUnavailableError(error instanceof Error ? error.message : "OpenRouter AI is not configured");
  }
  const parsed = JSON.parse(result.text) as { formula?: string; explanation?: string };
  const formula = parsed.formula?.trim().replace(/^=/, "").trim() ?? "";
  if (!formula || formula.length > 10_000) throw new Error("AI returned an invalid formula");
  return { formula, explanation: parsed.explanation?.trim() ?? "" };
}

/** A real row when the table has one, otherwise a placeholder value per column type. */
async function sampleRow(tableId: string, columns: { key: string; type: string }[]): Promise<CellValues> {
  const [row] = await db
    .select({ cells: gridRows.cells })
    .from(gridRows)
    .where(and(inOrgTables(gridRows.tableId), eq(gridRows.tableId, tableId)))
    .orderBy(asc(gridRows.position))
    .limit(1);
  const placeholder: Record<string, unknown> = { number: 1, currency: 1, boolean: true, email: "ada@example.com", url: "example.com", date: "2024-01-05" };
  const out: CellValues = {};
  for (const column of columns) out[column.key] = row?.cells[column.key] ?? placeholder[column.type] ?? "Sample";
  return out;
}

/** Errors that mean the formula itself is wrong, as opposed to the sample row's data. */
const STRUCTURAL_ERROR = /SyntaxError|ReferenceError|is not a function|is not defined/;

/** Null when the formula compiles, avoids Excel-only operators, and evaluates on the sample row. */
async function formulaProblem(tableId: string, formula: string, sample: CellValues): Promise<string | null> {
  const operator = excelOnlyOperator(formula);
  if (operator) return operator;
  try {
    await assertFormulaSyntax(formula);
    const config = await resolveFormulaConfig(tableId, formula);
    const registry = await buildFormulaLookupRegistry(config.lookupRefs);
    const result = await evaluateOnce(formula, sample, registry);
    if (!result.ok && STRUCTURAL_ERROR.test(result.error)) return result.error;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid formula";
  }
}
