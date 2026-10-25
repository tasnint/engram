/**
 * pnpm demo                 chat as user "u_you" (memories persist between runs)
 * pnpm demo --user alice    chat as someone else
 * pnpm demo --script        play two scripted conversations: tell it things in
 *                           the first, see it use them in the second
 *
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile) and the database
 * from `pnpm db:up && pnpm db:init`.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  connect,
  createEngram,
  duplicatesFromEnvironment,
  embeddingFromEnvironment,
  initializeDatabase,
} from "@engram/core";
import { createConversation, MODEL, type MemoryEvent } from "./agent.js";

const NAMESPACE = process.env.ENGRAM_NAMESPACE ?? "demo-agent";
const args = process.argv.slice(2);
const scripted = args.includes("--script");
const userFlag = args.indexOf("--user");
const userId = userFlag >= 0 ? args[userFlag + 1]! : scripted ? `u_script_${Date.now()}` : "u_you";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const showMemory = (e: MemoryEvent) =>
  console.log(
    dim(
      `  · ${{ recall: "recalled", remember: "remembered", forget: "forgot" }[e.tool]}: ${e.detail}`,
    ),
  );

const db = await connect();
try {
  const embeddings = embeddingFromEnvironment();
  await initializeDatabase(db.db, embeddings);
  const engram = createEngram({
    db: db.db,
    embeddings,
    duplicates: duplicatesFromEnvironment(db.db),
  });
  const newConversation = () =>
    createConversation({
      engram,
      namespace: NAMESPACE,
      userId,
      sessionId: randomUUID(),
      onMemory: showMemory,
    });

  console.log(dim(`Engram demo · ${MODEL} · ${NAMESPACE}/${userId} · ${embeddings.model}\n`));

  if (scripted) {
    const sessions = [
      [
        "Hi! I'm a backend engineer. Quick context: I write everything in Go, and I'm allergic to shellfish.",
        "Our deploys run on Fly.io. Yesterday one failed because a migration locked the users table for 40 seconds.",
      ],
      [
        "Can you give me a code example for retrying an HTTP request with backoff?",
        "I'm picking a restaurant for a team dinner. Anything I should keep in mind?",
        "What do you remember about our last deploy problem?",
      ],
    ];
    for (const [i, turns] of sessions.entries()) {
      console.log(
        bold(`── Conversation ${i + 1} ${i === 1 ? "(new session, no shared chat history)" : ""}`),
      );
      const conversation = newConversation();
      for (const turn of turns) {
        console.log(`\n${bold("You:")} ${turn}`);
        const { text } = await conversation.send(turn);
        console.log(`${bold("Claude:")} ${text}`);
      }
      console.log();
    }
  } else {
    const conversation = newConversation();
    const rl = createInterface({ input: stdin, output: stdout });
    console.log(
      dim(
        "Type a message. Ctrl+C or an empty line to quit. Restart to begin a new conversation.\n",
      ),
    );
    for (;;) {
      const line = (await rl.question(bold("You: "))).trim();
      if (!line) break;
      const { text } = await conversation.send(line);
      console.log(`${bold("Claude:")} ${text}\n`);
    }
    rl.close();
  }
} finally {
  await db.close();
}
