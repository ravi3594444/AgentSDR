import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hashKnowledgeExcerpt,
  knowledgeSearchText,
  queryKnowledgeCandidates,
  selectKnowledgeCandidates,
  type KnowledgeCandidate,
} from "./knowledge";
import type { CrmExecutor } from "./repository";
import { runInOrganization } from "@/lib/tenancy/scope";

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    documentId: "doc-1",
    documentVersionId: "version-1",
    title: "Product overview",
    kind: "product",
    tags: ["product"],
    alwaysInclude: false,
    content: "The product helps revenue teams qualify demand.",
    rank: 0.1,
    ...overrides,
  };
}

describe("CRM Knowledge retrieval", () => {
  test("always-included documents precede tag and full-text candidates", () => {
    const result = selectKnowledgeCandidates([
      candidate({ documentId: "ranked", documentVersionId: "ranked-v1", rank: 10 }),
      candidate({ documentId: "tagged", documentVersionId: "tagged-v1", tags: ["pricing"], rank: 1 }),
      candidate({ documentId: "always", documentVersionId: "always-v1", alwaysInclude: true, rank: 0 }),
    ], { knowledgeTags: ["pricing"], maxTokens: 100 });

    assert.deepEqual(result.entries.map((entry) => entry.documentId), ["always", "tagged", "ranked"]);
  });

  test("uses supplied tag overlap and PostgreSQL-like ranks deterministically", () => {
    const result = selectKnowledgeCandidates([
      candidate({ documentId: "low", documentVersionId: "low-v1", rank: 9, tagOverlapCount: 0 }),
      candidate({ documentId: "high", documentVersionId: "high-v1", rank: 0.2, tagOverlapCount: 2 }),
      candidate({ documentId: "same", documentVersionId: "same-v1", rank: 0.8, tagOverlapCount: 2 }),
    ], { maxTokens: 100 });

    assert.deepEqual(result.entries.map((entry) => entry.documentId), ["same", "high", "low"]);
  });

  test("truncates the final excerpt at a deterministic token boundary", () => {
    const result = selectKnowledgeCandidates([
      candidate({ content: "0123456789ABCDEFGHIJ", rank: 1 }),
      candidate({ documentId: "second", documentVersionId: "second-v1", content: "another document", rank: 0 }),
    ], { maxTokens: 5 });

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.excerpt, "0123456789ABCDEFGHIJ");
    assert.equal(result.truncated, true);

    const clipped = selectKnowledgeCandidates([
      candidate({ content: "a".repeat(100) }),
    ], { maxTokens: 5 });
    assert.equal(clipped.entries[0]?.excerpt.length, 20);
    assert.equal(clipped.truncated, true);
    assert.ok(clipped.estimatedTokens <= 5);
  });

  test("counts separators between excerpts against the token budget", () => {
    const result = selectKnowledgeCandidates([
      candidate({ content: "a".repeat(10), rank: 2 }),
      candidate({ documentId: "second", documentVersionId: "second-v1", content: "b".repeat(10), rank: 1 }),
    ], { maxTokens: 5 });

    assert.equal(result.entries.map((entry) => entry.excerpt).join("\n\n").length, 20);
    assert.equal(result.truncated, true);
    assert.ok(result.estimatedTokens <= 5);
  });

  test("citation hashes are stable and identify the exact selected version", () => {
    const first = selectKnowledgeCandidates([candidate({ documentVersionId: "v-exact" })], { maxTokens: 100 });
    const second = selectKnowledgeCandidates([candidate({ documentVersionId: "v-exact" })], { maxTokens: 100 });
    assert.deepEqual(first.citations, second.citations);
    assert.equal(first.citations[0]?.documentVersionId, "v-exact");
    assert.equal(first.citations[0]?.excerptHash, hashKnowledgeExcerpt(first.citations[0]?.excerpt ?? ""));
    assert.equal(first.citations[0]?.rank, 0.1);
    assert.ok(Object.isFrozen(first.citations[0]));
  });

  test("query joins the declared latest version and uses websearch ranking", async () => {
    let executed = false;
    const executor = {
      select: (() => { throw new Error("query helper must use SQL execute"); }) as never,
      insert: (() => { throw new Error("query helper must not mutate"); }) as never,
      update: (() => { throw new Error("query helper must not mutate"); }) as never,
      delete: (() => { throw new Error("query helper must not mutate"); }) as never,
      execute: async () => {
        executed = true;
        return [{
          documentId: "doc-1",
          documentVersionId: "version-2",
          title: "Pricing",
          kind: "pricing",
          tags: ["pricing"],
          alwaysInclude: true,
          content: "Pricing content",
          rank: 0.5,
          tagOverlapCount: 1,
        }];
      },
    };

    const rows = await runInOrganization("00000000-0000-0000-0000-00000000000a", () =>
      queryKnowledgeCandidates(executor as unknown as CrmExecutor, {
        query: "pricing",
        knowledgeTags: ["pricing"],
      }));
    assert.equal(rows[0]?.documentVersionId, "version-2");
    assert.equal(executed, true);
  });
});

describe("knowledgeSearchText", () => {
  test("a sentence becomes its significant words, any of which may match", () => {
    assert.equal(knowledgeSearchText("Hi Ravi, how much is your monthly maintenance plan per chair?"), "ravi or monthly or maintenance or plan or per or chair");
    assert.equal(knowledgeSearchText(""), "");
    assert.equal(knowledgeSearchText(null), "");
  });
});
