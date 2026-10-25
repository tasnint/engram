import { describe, expect, it } from "vitest";
import type { Collection } from "mongodb";
import { recall, RecallInputError } from "../../src/read/recall.js";
import { HashEmbedder } from "../../src/embeddings/hash-embedder.js";
import type { MemoryDoc, MemoryType } from "../../src/types.js";

// Validation runs before any database call, so a dummy collection is enough.
const deps = { memories: {} as Collection<MemoryDoc>, embedder: new HashEmbedder(16) };
const base = { namespace: "bot", userId: "u1", query: "hello" };

describe("recall input validation", () => {
  it.each([
    [{ ...base, query: "   " }, /query/],
    [{ ...base, namespace: "" }, /namespace/],
    [{ ...base, userId: "" }, /userId/],
    [{ ...base, k: 0 }, /k must/],
    [{ ...base, k: 51 }, /k must/],
    [{ ...base, k: 2.5 }, /k must/],
    [{ ...base, types: ["opinion" as MemoryType] }, /Unknown memory type/],
    [{ ...base, since: new Date("nope") }, /since/],
  ])("rejects %o", async (input, message) => {
    await expect(recall(deps, input)).rejects.toThrow(RecallInputError);
    await expect(recall(deps, input)).rejects.toThrow(message);
  });
});
