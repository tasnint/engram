/**
 * A chat agent on Claude that remembers the user between conversations.
 *
 * Memory is three tools backed by Engram, called in-process. Claude decides
 * when to recall (start of a task, when earlier context might matter) and
 * when to remember (durable facts, preferences, notable events).
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { MEMORY_TYPES, type Engram } from "@engram/core";
import { z } from "zod";

export const MODEL = "claude-opus-5-5";

const SYSTEM = `You are a helpful assistant with long-term memory that persists across conversations.

Memory tools:
- recall_memories: search what you know about this user from earlier conversations. Use it at the start of a conversation and whenever earlier context could change your answer (preferences, their stack, past problems).
- remember: save something worth knowing next time: a fact about the user, a preference, or a notable event. One idea per call, written as a standalone sentence in the third person ("Prefers Python for examples"). Don't save small talk or things only relevant to this message.
- forget_memory: delete a memory when the user says it's wrong or asks you to forget it.

Use what you recall naturally. Don't announce every tool call or recite memories back unless asked.`;

export interface MemoryEvent {
  tool: "recall" | "remember" | "forget";
  detail: string;
}

export interface AgentOptions {
  engram: Engram;
  namespace: string;
  userId: string;
  sessionId: string;
  client?: Anthropic;
  /** Called on every memory tool use, so the UI can show memory at work. */
  onMemory?: (event: MemoryEvent) => void;
}

export function createMemoryTools({
  engram,
  namespace,
  userId,
  sessionId,
  onMemory,
}: AgentOptions) {
  const recallTool = betaZodTool({
    name: "recall_memories",
    description:
      "Search long-term memory about the user. Returns the most relevant memories with their ids.",
    inputSchema: z.object({
      query: z.string().min(1).describe("What you're looking for, in plain words"),
      k: z.number().int().min(1).max(20).optional().describe("How many memories (default 5)"),
    }),
    run: async ({ query, k }) => {
      const results = await engram.recall({ namespace, userId, query, k });
      onMemory?.({ tool: "recall", detail: `"${query}" → ${results.length} found` });
      if (results.length === 0) return "No memories found.";
      return results
        .map(
          (r) =>
            `- [${r.memory.type}] ${r.memory.content} (id ${r.memory._id.toHexString()}, saved ${r.memory.createdAt.toISOString().slice(0, 10)})`,
        )
        .join("\n");
    },
  });

  const rememberTool = betaZodTool({
    name: "remember",
    description: "Save one memory about the user for future conversations.",
    inputSchema: z.object({
      content: z
        .string()
        .min(1)
        .max(2000)
        .describe("The memory as a standalone third-person sentence"),
      type: z.enum(MEMORY_TYPES).exclude(["summary"]).describe("fact, preference or episode"),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("0 = trivia, 1 = critical, like an allergy"),
    }),
    run: async ({ content, type, importance }) => {
      const memory = await engram.remember({
        namespace,
        userId,
        content,
        type,
        importance,
        source: { sessionId, messageId: null },
      });
      onMemory?.({ tool: "remember", detail: content });
      return `Saved (id ${memory._id.toHexString()}).`;
    },
  });

  const forgetTool = betaZodTool({
    name: "forget_memory",
    description: "Delete one memory by id.",
    inputSchema: z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) }),
    run: async ({ id }) => {
      const { deleted } = await engram.forget({ id });
      onMemory?.({ tool: "forget", detail: id });
      return deleted ? "Forgotten." : "No memory with that id.";
    },
  });

  return [recallTool, rememberTool, forgetTool];
}

/** One conversation. History is append-only: every turn, including tool calls, is kept as sent. */
export function createConversation(options: AgentOptions) {
  const client = options.client ?? new Anthropic();
  const tools = createMemoryTools(options);
  let history: BetaMessageParam[] = [];

  return {
    async send(text: string): Promise<{ text: string; message: BetaMessage }> {
      const runner = client.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
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
      if (history.at(-1)?.role !== "assistant")
        history.push({ role: "assistant", content: message.content });

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
