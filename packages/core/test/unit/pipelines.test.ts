import { describe, expect, it } from "vitest";
import {
  buildRankFusionPipeline,
  buildTextPipeline,
  buildVectorPipeline,
  textFilterClauses,
  vectorFilter,
} from "../../src/read/pipelines.js";
import {
  FILTER_FIELDS,
  textIndexDefinition,
  vectorIndexDefinition,
} from "../../src/read/indexes.js";

const scope = { namespace: "bot", userId: "u1" };
const since = new Date("2026-01-01T00:00:00Z");

describe("vector search pipeline", () => {
  it("pre-filters to active memories for one user", () => {
    expect(vectorFilter(scope)).toEqual({
      $and: [
        { namespace: { $eq: "bot" } },
        { userId: { $eq: "u1" } },
        { status: { $eq: "active" } },
      ],
    });
  });

  it("adds type and date filters when given", () => {
    const f = vectorFilter({ ...scope, types: ["fact"], since });
    expect(f.$and).toContainEqual({ type: { $in: ["fact"] } });
    expect(f.$and).toContainEqual({ createdAt: { $gte: since } });
  });

  it("never returns embeddings or storage-only fields", () => {
    const p = buildVectorPipeline(scope, [0.1, 0.2], { limit: 10 });
    expect(p.at(-1)).toEqual({ $project: { embedding: 0, contentHash: 0, decayAt: 0 } });
    expect(p[0]?.$vectorSearch.numCandidates).toBe(150);
  });

  it("only filters on fields the vector index declares", () => {
    const declared = new Set(
      vectorIndexDefinition(8)
        .definition.fields.filter((f: { type: string }) => f.type === "filter")
        .map((f: { path: string }) => f.path),
    );
    const used = vectorFilter({ ...scope, types: ["fact"], since }).$and.map(
      (c: object) => Object.keys(c)[0],
    );
    for (const field of used) expect(declared.has(field)).toBe(true);
  });
});

describe("text search pipeline", () => {
  it("filters in a way that doesn't change the score", () => {
    const [stage] = buildTextPipeline(scope, "deploy", 5);
    expect(stage?.$search.compound.must).toEqual([{ text: { query: "deploy", path: "content" } }]);
    expect(stage?.$search.compound.filter).toEqual(textFilterClauses(scope));
  });

  it("only filters on fields the text index maps", () => {
    const mapped = textIndexDefinition().definition.mappings.fields;
    const used = textFilterClauses({ ...scope, types: ["fact"], since }).map(
      (c) => (Object.values(c)[0] as { path: string }).path,
    );
    for (const field of used) expect(mapped).toHaveProperty(field);
    for (const field of FILTER_FIELDS) expect(mapped).toHaveProperty(field);
  });
});

describe("$rankFusion pipeline", () => {
  it("combines both searches with weights", () => {
    const [stage] = buildRankFusionPipeline(scope, "deploy", [0.1], {
      limit: 8,
      weights: { vector: 2, text: 1 },
    });
    expect(Object.keys(stage?.$rankFusion.input.pipelines)).toEqual(["vector", "text"]);
    expect(stage?.$rankFusion.combination.weights).toEqual({ vector: 2, text: 1 });
    expect(stage?.$rankFusion.scoreDetails).toBe(true);
  });
});
