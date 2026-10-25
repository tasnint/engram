import { describe, expect, it } from "vitest";
import { HashEmbedder, tokenize } from "../../src/embeddings/hash-embedder.js";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("HashEmbedder", () => {
  const e = new HashEmbedder(256);

  it("returns unit vectors of the right length", async () => {
    const [v] = await e.embed(["Prefers Python"], "document");
    expect(v).toHaveLength(256);
    expect(Math.hypot(...v!)).toBeCloseTo(1);
  });

  it("is deterministic", async () => {
    const [a] = await e.embed(["deploy failed"], "document");
    const [b] = await e.embed(["deploy failed"], "query");
    expect(a).toEqual(b);
  });

  it("scores texts that share words higher", async () => {
    const [q, near, far] = await e.embed(
      [
        "why did the deploy fail",
        "Deploy failed on Tuesday because of the Helm chart",
        "Has a dog named Biscuit",
      ],
      "document",
    );
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!) + 0.2);
  });

  it("handles empty text", async () => {
    const [v] = await e.embed([""], "document");
    expect(Math.hypot(...v!)).toBeCloseTo(1);
  });

  it("drops stopwords and punctuation", () => {
    expect(tokenize("The deploy, it FAILED!")).toEqual(["deploy", "failed"]);
  });
});
