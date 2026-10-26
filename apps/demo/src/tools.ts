/**
 * The demo agent's memory: three tools backed by Engram, called in-process.
 * Shared by every model backend (local Ollama model or Claude).
 */
import { MEMORY_TYPES, type Engram } from "@engram/core";
import { z } from "zod";

export const SYSTEM_PROMPT = `You are a helpful assistant with long-term memory that persists across conversations.

Memory tools:
- recall_memories: search what you know about this user from earlier conversations. Call it before answering any question where the user's preferences, situation or history could matter, and at the start of a conversation.
- remember: save something worth knowing next time: a fact about the user, a preference, or a notable event. One idea per call, written as a standalone sentence in the third person ("Prefers Python for examples"). Save each new fact the user tells you about themselves. Don't save small talk.
- forget_memory: delete a memory when the user says it's wrong or asks you to forget it.

Use what you recall naturally in your answer. Don't recite memories back unless asked.`;

export interface MemoryEvent {
  tool: "recall" | "remember" | "forget";
  detail: string;
}

export interface MemoryToolOptions {
  engram: Engram;
  namespace: string;
  userId: string;
  sessionId: string;
  /** Called on every memory tool use, so the UI can show memory at work. */
  onMemory?: (event: MemoryEvent) => void;
}

export interface MemoryTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<string>;
}

const tool = <S extends z.ZodType>(t: MemoryTool<S>) => t;

export function memoryTools({ engram, namespace, userId, sessionId, onMemory }: MemoryToolOptions) {
  return [
    tool({
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
    }),
    tool({
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
    }),
    tool({
      name: "forget_memory",
      description: "Delete one memory by id.",
      inputSchema: z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) }),
      run: async ({ id }) => {
        const { deleted } = await engram.forget({ id });
        onMemory?.({ tool: "forget", detail: id });
        return deleted ? "Forgotten." : "No memory with that id.";
      },
    }),
  ];
}

/** Common shape for one conversation, whatever model runs it. */
export interface Conversation {
  send(text: string): Promise<{ text: string }>;
}
