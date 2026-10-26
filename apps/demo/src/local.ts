/**
 * Default backend: a small free model running on the CPU (LocalChatModel,
 * ~365 MB download, no API key).
 *
 * Small models can't reliably decide when to call tools, so memory is
 * automatic instead (retrieval-augmented generation):
 *   1. recall the memories most related to the message,
 *   2. put them in the message the model sees,
 *   3. after replying, save what the user said about themselves.
 */
import { LocalChatModel, type ChatMessage, type MemoryType } from "@engram/core";
import type { Conversation, MemoryToolOptions } from "./tools.js";

const MAX_MEMORIES = 3;
/** Earlier exchanges kept in the prompt. Small models get confused by long ones. */
const HISTORY_TURNS = 1;

// Kept short and plain: small models tend to repeat longer instructions back.
const SYSTEM = "You are a helpful assistant. Answer in a few sentences.";

export interface LocalOptions extends MemoryToolOptions {
  chatModel?: Pick<LocalChatModel, "chat">;
}

/**
 * What to save from a user message: each statement as its own memory, so each
 * can be recalled on its own. Questions and greetings are skipped. In a
 * one-on-one chat, what the user states is almost always about their world.
 */
export function memoriesFromMessage(text: string): Array<{ content: string; type: MemoryType }> {
  return (
    text
      // Sentence ends: . ! ? followed by a space (so "Fly.io" stays whole).
      .split(/(?<=[.!?])\s+/)
      // "Yesterday one failed..." only makes sense with the sentence before it.
      .reduce<string[]>((sentences, sentence) => {
        const refersBack = /^(\w+\s+)?(one|it|this|that|they|those|these)\b/i.test(sentence);
        if (refersBack && sentences.length) sentences[sentences.length - 1] += ` ${sentence}`;
        else sentences.push(sentence);
        return sentences;
      }, [])
      // "..., and I'm ..." holds two separate facts.
      .flatMap((sentence) => sentence.split(/,\s*and\s+(?=(?:i|i'm|i've|my|we|our)\b)/i))
      .map((part) =>
        part
          .trim()
          .replace(/^(hi|hey|hello)\b[!,.]?\s*/i, "")
          .replace(/^quick context:\s*/i, ""),
      )
      .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
      .filter((part) => part.length >= 12 && !part.endsWith("?"))
      .map((part) => ({ content: part[0]!.toUpperCase() + part.slice(1), type: memoryType(part) }))
  );
}

function memoryType(sentence: string): MemoryType {
  if (/\b(prefer|like|love|hate|favou?rite|always|never|rather)\b/i.test(sentence))
    return "preference";
  if (/\b(yesterday|today|last (week|night|time)|just|happened|failed|broke)\b/i.test(sentence))
    return "episode";
  return "fact";
}

export function createLocalConversation(options: LocalOptions): Conversation {
  const { engram, namespace, userId, sessionId, onMemory } = options;
  const chatModel =
    options.chatModel ?? new LocalChatModel({ model: process.env.CHAT_MODEL || undefined });
  const history: ChatMessage[] = [];

  return {
    async send(text: string) {
      const results = await engram.recall({ namespace, userId, query: text, k: MAX_MEMORIES });
      // Recall scores are relative to the other candidates, so a fixed cutoff
      // misfires when a user has only a few memories. Pass the top matches.
      const relevant = results;
      onMemory?.({
        tool: "recall",
        detail: relevant.length
          ? relevant.map((r) => `"${r.memory.content}" (${r.score.toFixed(2)})`).join(", ")
          : "nothing relevant",
      });

      // Small models use context in the user's own message far better than in the system prompt.
      const withMemories = relevant.length
        ? `Notes about me:\n${relevant.map((r) => `- ${r.memory.content}`).join("\n")}\n\nWith those notes in mind: ${text}`
        : text;

      const reply = await chatModel.chat(
        [
          { role: "system", content: SYSTEM },
          ...history.slice(-HISTORY_TURNS * 2),
          { role: "user", content: withMemories },
        ],
        { maxNewTokens: 150 },
      );
      history.push({ role: "user", content: text }, { role: "assistant", content: reply });

      for (const memory of memoriesFromMessage(text)) {
        await engram.remember({
          namespace,
          userId,
          ...memory,
          source: { sessionId, messageId: null },
        });
        onMemory?.({ tool: "remember", detail: memory.content });
      }
      return { text: reply };
    },
  };
}
