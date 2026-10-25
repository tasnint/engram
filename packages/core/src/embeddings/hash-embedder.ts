import type { EmbedKind, EmbeddingProvider } from "../types.js";

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have i in is it its me my of on or our so " +
    "that the their them they this to was we were what when which who will with you your"
  ).split(" "),
);

/**
 * A free, offline stand-in for a real embedding model, for development and tests.
 *
 * It uses feature hashing: each word (and each 3-letter chunk, so "deploy" and
 * "deployment" overlap) is hashed to one slot of the vector. Texts that share
 * words get similar vectors. It knows nothing about meaning ("car" and
 * "automobile" don't match), so use a real model (P4) for real recall quality.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly model = "hash-v1";
  readonly dimensions: number;

  constructor(dimensions = 256) {
    if (!Number.isInteger(dimensions) || dimensions < 8) {
      throw new Error(`HashEmbedder needs an integer dimension of at least 8, got ${dimensions}`);
    }
    this.dimensions = dimensions;
  }

  async embed(texts: string[], _kind?: EmbedKind): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const word of tokenize(text)) {
      this.add(vector, `w:${word}`, 1);
      const padded = `^${word}$`;
      for (let i = 0; i + 3 <= padded.length; i++) {
        this.add(vector, `g:${padded.slice(i, i + 3)}`, 0.3);
      }
    }
    const norm = Math.hypot(...vector);
    if (norm === 0) {
      // Empty or all-stopword text. Cosine similarity is undefined for a zero
      // vector, so return a fixed unit vector instead.
      vector[0] = 1;
      return vector;
    }
    return vector.map((x) => x / norm);
  }

  private add(vector: number[], feature: string, weight: number): void {
    const h = fnv1a(feature);
    const slot = h % this.dimensions;
    // A second bit picks the sign, so unrelated features tend to cancel out.
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vector[slot] = (vector[slot] ?? 0) + sign * weight;
  }
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOPWORDS.has(w));
}

/** 32-bit FNV-1a hash. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
