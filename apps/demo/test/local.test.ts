import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { Engram, Memory } from "@engram/core";
import { createLocalConversation, memoriesFromMessage } from "../src/local.js";

const hit = (content: string, score: number) => ({
  memory: { _id: new ObjectId(), content } as Memory,
  score,
  signals: { relevance: 1, importance: 1, recency: 1, vectorRank: 1, textRank: null },
});

function setup(recalled: ReturnType<typeof hit>[]) {
  const engram = {
    recall: vi.fn(async () => recalled),
    remember: vi.fn(async () => ({}) as Memory),
    forget: vi.fn(),
    list: vi.fn(),
    service: {},
  } as unknown as Engram & { recall: ReturnType<typeof vi.fn>; remember: ReturnType<typeof vi.fn> };
  const chat = vi.fn(async (_messages: unknown, _options?: unknown) => "Sounds good.");
  const conversation = createLocalConversation({
    engram,
    chatModel: { chat },
    namespace: "demo-agent",
    userId: "u1",
    sessionId: "s1",
  });
  return { engram, chat, conversation };
}

describe("memoriesFromMessage", () => {
  it.each([
    ["I'm allergic to shellfish.", "fact"],
    ["I prefer Go for everything.", "preference"],
    ["Our deploy failed yesterday because of a migration lock.", "episode"],
  ])("saves %s as a %s", (text, type) => {
    expect(memoriesFromMessage(text)).toEqual([{ content: text, type }]);
  });

  it("splits a message into one memory per statement", () => {
    expect(
      memoriesFromMessage(
        "Hi! I'm a backend engineer. Quick context: I write everything in Go, and I'm allergic to shellfish. What's new?",
      ).map((m) => m.content),
    ).toEqual([
      "I'm a backend engineer.",
      "I write everything in Go.",
      "I'm allergic to shellfish.",
    ]);
  });

  it('doesn\'t split on dots inside names, and keeps "one" with what it refers to', () => {
    expect(
      memoriesFromMessage(
        "Our deploys run on Fly.io. Yesterday one failed because a migration locked the users table.",
      ),
    ).toEqual([
      {
        content:
          "Our deploys run on Fly.io. Yesterday one failed because a migration locked the users table.",
        type: "episode",
      },
    ]);
  });

  it.each(["What should I eat?", "hi there", "Thanks!"])("skips %s", (text) => {
    expect(memoriesFromMessage(text)).toEqual([]);
  });
});

describe("local backend", () => {
  it("passes relevant memories to the model inside the user's message", async () => {
    const { engram, chat, conversation } = setup([
      hit("I'm allergic to shellfish.", 0.82),
      hit("I have a corgi named Biscuit.", 0.31),
    ]);
    expect((await conversation.send("Where should the team eat?")).text).toBe("Sounds good.");
    expect(engram.recall).toHaveBeenCalledWith({
      namespace: "demo-agent",
      userId: "u1",
      query: "Where should the team eat?",
      k: 3,
    });
    const messages = chat.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const last = messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("- I'm allergic to shellfish.");
    expect(last.content).toContain("- I have a corgi named Biscuit.");
    expect(last.content).toMatch(/^Notes about me:\n/);
    expect(last.content.endsWith("\n\nWith those notes in mind: Where should the team eat?")).toBe(
      true,
    );
    expect(engram.remember).not.toHaveBeenCalled(); // a question, not a fact
  });

  it("saves facts the user states and keeps a short history", async () => {
    const { engram, chat, conversation } = setup([]);
    await conversation.send("I write everything in Go.");
    expect(engram.remember).toHaveBeenCalledWith({
      namespace: "demo-agent",
      userId: "u1",
      content: "I write everything in Go.",
      type: "fact",
      source: { sessionId: "s1", messageId: null },
    });
    await conversation.send("What's a good retry library?");
    const messages = chat.mock.calls[1]![0] as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages.at(-1)!.content).toBe("What's a good retry library?"); // no memories, so no preamble
  });
});
