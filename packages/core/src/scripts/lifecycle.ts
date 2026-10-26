/**
 * pnpm lifecycle decay                          lower importance by elapsed time (A4)
 * pnpm lifecycle consolidate <namespace> [days] merge old episodes into summaries (A5)
 */
import { MongoClient } from "mongodb";
import { DEFAULT_MONGODB_URI } from "../config.js";
import { initializeDatabase } from "../database.js";
import { embeddingFromEnvironment } from "../embeddings/index.js";
import { LocalChatModel, LocalSummarizer } from "../llm/local-chat.js";
import { ChatCompletionSummarizer } from "../summarizer.js";
import { consolidateEpisodes, decayImportance } from "../write/lifecycle.js";

const action = process.argv[2];
if (!["decay", "consolidate"].includes(action ?? ""))
  throw new Error("Usage: pnpm lifecycle <decay|consolidate> [namespace] [minimum-age-days]");
const client = new MongoClient(process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI);
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE ?? "engram");
  const embeddings = embeddingFromEnvironment();
  await initializeDatabase(db, embeddings);
  if (action === "decay") {
    console.log(
      JSON.stringify({
        updated: await decayImportance(db, {
          halfLifeDays: Number(process.env.IMPORTANCE_HALF_LIFE_DAYS ?? 90),
        }),
      }),
    );
  } else {
    const namespace = process.argv[3];
    const days = Number(process.argv[4] ?? 7);
    if (!namespace || !Number.isFinite(days) || days <= 0)
      throw new Error("Supply a namespace and a positive minimum age in days.");
    // An OpenAI-compatible endpoint if configured, otherwise the free local model.
    const summarizer =
      process.env.SUMMARIZER_URL && process.env.SUMMARIZER_MODEL
        ? new ChatCompletionSummarizer({
            url: process.env.SUMMARIZER_URL,
            model: process.env.SUMMARIZER_MODEL,
            apiKey: process.env.SUMMARIZER_API_KEY,
          })
        : new LocalSummarizer(new LocalChatModel({ model: process.env.CHAT_MODEL || undefined }));
    const summaries = await consolidateEpisodes({
      client,
      db,
      embeddings,
      summarizer,
      namespace,
      olderThan: new Date(Date.now() - days * 86400000),
    });
    console.log(
      JSON.stringify({
        consolidated: summaries.length,
        summaryIds: summaries.map((summary) => summary._id),
      }),
    );
  }
} finally {
  await client.close();
}
