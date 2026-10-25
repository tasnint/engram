import { z } from "zod";
import { EngramError } from "../errors.js";
import type { EmbeddingProvider } from "../types.js";

export function validateEmbeddings(
  vectors: number[][],
  count: number,
  dimensions: number,
): number[][] {
  if (
    vectors.length !== count ||
    vectors.some(
      (vector) =>
        vector.length !== dimensions ||
        vector.some((value) => !Number.isFinite(value)) ||
        !vector.some((value) => value !== 0),
    )
  ) {
    throw new EngramError(
      "INVALID_EMBEDDING",
      `Expected ${count} nonzero vectors of ${dimensions} finite numbers.`,
      502,
    );
  }
  return vectors;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  constructor(
    private readonly options: {
      apiKey: string;
      model?: string;
      dimensions?: number;
      fetch?: typeof fetch;
    },
  ) {
    if (!options.apiKey) throw new Error("VOYAGE_API_KEY is required.");
    this.model = options.model ?? "voyage-4-lite";
    this.dimensions = options.dimensions ?? 1024;
    if (![256, 512, 1024, 2048].includes(this.dimensions))
      throw new Error("Unsupported Voyage dimensions.");
  }

  async embed(texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
    if (!texts.length) return [];
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += 128) {
      const batch = texts.slice(start, start + 128);
      const response = await (this.options.fetch ?? fetch)(
        "https://api.voyageai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({
            input: batch,
            model: this.model,
            input_type: inputType,
            output_dimension: this.dimensions,
            truncation: false,
          }),
        },
      );
      if (!response.ok)
        throw new EngramError(
          "EMBEDDING_UNAVAILABLE",
          `Voyage returned HTTP ${response.status}.`,
          502,
        );
      const result = z
        .object({
          data: z.array(
            z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }),
          ),
        })
        .parse(await response.json());
      const sorted = result.data.sort((a, b) => a.index - b.index);
      if (sorted.some((entry, index) => entry.index !== index))
        throw new EngramError("INVALID_EMBEDDING", "Voyage returned invalid vector indices.", 502);
      vectors.push(
        ...validateEmbeddings(
          sorted.map((entry) => entry.embedding),
          batch.length,
          this.dimensions,
        ),
      );
    }
    return vectors;
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private extractor?: Promise<(texts: string[]) => Promise<number[][]>>;

  constructor(
    private readonly options: {
      model?: string;
      dimensions?: number;
      offline?: boolean;
      localModelPath?: string;
    } = {},
  ) {
    this.model = options.model ?? "Xenova/all-MiniLM-L6-v2";
    this.dimensions = options.dimensions ?? 384;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 1)
      throw new Error("Embedding dimensions must be positive.");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    this.extractor ??= this.load();
    try {
      return validateEmbeddings(await (await this.extractor)(texts), texts.length, this.dimensions);
    } catch (error) {
      this.extractor = undefined;
      throw error;
    }
  }

  private async load(): Promise<(texts: string[]) => Promise<number[][]>> {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowRemoteModels = !this.options.offline;
    if (this.options.localModelPath) env.localModelPath = this.options.localModelPath;
    const extractor = await pipeline("feature-extraction", this.model, { dtype: "q8" });
    return async (texts) => {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      return output.tolist() as number[][];
    };
  }
}
