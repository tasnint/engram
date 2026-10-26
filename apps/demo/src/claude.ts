/**
 * Optional backend: Claude via the Anthropic API (needs ANTHROPIC_API_KEY,
 * which is a paid account). The default backend is the free local model in
 * ollama.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { memoryTools, SYSTEM_PROMPT, type Conversation, type MemoryToolOptions } from "./tools.js";

export const CLAUDE_MODEL = "claude-opus-5-5";

export interface ClaudeOptions extends MemoryToolOptions {
  client?: Anthropic;
}

/** One conversation. History is append-only: every turn, including tool calls, is kept as sent. */
export function createClaudeConversation(
  options: ClaudeOptions,
): Conversation & { send(text: string): Promise<{ text: string; message: BetaMessage }> } {
  const client = options.client ?? new Anthropic();
  const tools = memoryTools(options).map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      // Each tool's run matches its own schema; the union type can't express that.
      run: (input) => (t.run as (args: unknown) => Promise<string>)(input),
    }),
  );
  let history: BetaMessageParam[] = [];

  return {
    async send(text: string) {
      const runner = client.beta.messages.toolRunner({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        // Chat replies don't need deep reasoning; low effort keeps them quick.
        output_config: { effort: "low" },
        // If a safety classifier declines, the API retries on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools,
        messages: [...history, { role: "user", content: text }],
        max_iterations: 8,
      });
      const message = await runner.runUntilDone();
      history = [...runner.params.messages];
      if (history.at(-1)?.role !== "assistant") {
        history.push({ role: "assistant", content: message.content });
      }

      if (message.stop_reason === "refusal") {
        return { text: "(Claude declined to answer that.)", message };
      }
      const reply = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { text: reply, message };
    },
  };
}
