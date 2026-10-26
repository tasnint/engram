/**
 * A small chat model that runs on the CPU in this process, through
 * Transformers.js (the same library as the local embedding model). Free and
 * offline after a one-time download (~365 MB for the default model).
 *
 * Small models are weak at tool calling and at following long system prompts,
 * so callers should hand them the context they need in the user message (see
 * apps/demo/src/local.ts) rather than expect them to look things up.
 */
import { EngramError } from "../errors.js";
import type { MemoryDoc, Summarizer } from "../types.js";

export const DEFAULT_CHAT_MODEL = "HuggingFaceTB/SmolLM2-360M-Instruct";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type Generate = (messages: ChatMessage[], maxNewTokens: number) => Promise<string>;

export class LocalChatModel {
  readonly model: string;
  private generator?: Promise<Generate>;

  constructor(options: { model?: string } = {}) {
    this.model = options.model ?? DEFAULT_CHAT_MODEL;
  }

  async chat(messages: ChatMessage[], options: { maxNewTokens?: number } = {}): Promise<string> {
    this.generator ??= this.load();
    try {
      return (await (await this.generator)(messages, options.maxNewTokens ?? 200)).trim();
    } catch (error) {
      this.generator = undefined;
      throw error;
    }
  }

  private async load(): Promise<Generate> {
    const { pipeline } = await import("@huggingface/transformers");
    // q8: 8-bit weights. About a quarter of the full size and fast on a CPU.
    const generator = await pipeline("text-generation", this.model, { dtype: "q8" });
    return async (messages, maxNewTokens) => {
      const output = (await generator(messages, {
        max_new_tokens: maxNewTokens,
        do_sample: false,
        repetition_penalty: 1.1,
      })) as Array<{ generated_text: ChatMessage[] }>;
      return output[0]?.generated_text.at(-1)?.content ?? "";
    };
  }
}

/** Consolidation (A5) summarizer on the local model, for when no SUMMARIZER_URL is set. */
export class LocalSummarizer implements Summarizer {
  constructor(private readonly chatModel = new LocalChatModel()) {}

  async summarize(episodes: readonly Pick<MemoryDoc, "content" | "createdAt">[]): Promise<string> {
    const list = episodes
      .map((e) => `- ${e.createdAt.toISOString().slice(0, 10)}: ${e.content}`)
      .join("\n");
    const summary = await this.chatModel.chat(
      [
        {
          role: "system",
          content: "You summarize notes. Keep every fact and date. Don't add anything.",
        },
        {
          role: "user",
          content: `Summarize these notes about a user in one or two sentences:\n${list}`,
        },
      ],
      { maxNewTokens: 160 },
    );
    if (!summary)
      throw new EngramError("INVALID_SUMMARY", "The local model returned nothing.", 502);
    return summary.slice(0, 16000);
  }
}
