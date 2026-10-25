/**
 * pnpm db:seed: loads sample memories for user "u_demo" of agent "demo-agent".
 * Re-running replaces the previous sample data. Writes go through remember()
 * (A2), backdated with an injected clock, so they pass schema validation and
 * get real embeddings, tags and dedup.
 */
import { connect } from "../db.js";
import { initializeDatabase } from "../database.js";
import { embeddingFromEnvironment } from "../embeddings/index.js";
import { MemoryService } from "../write/service.js";
import { SAMPLE_MEMORIES } from "../samples.js";

const NAMESPACE = "demo-agent";
const USER = "u_demo";
const DAY = 24 * 60 * 60 * 1000;

const embeddings = embeddingFromEnvironment();
const engram = await connect();
try {
  await initializeDatabase(engram.db, embeddings);
  await engram.memories.deleteMany({ namespace: NAMESPACE, userId: USER });
  const now = Date.now();
  for (const sample of SAMPLE_MEMORIES) {
    const service = new MemoryService(engram.db, {
      embeddings,
      now: () => new Date(now - sample.daysAgo * DAY),
    });
    await service.remember({
      namespace: NAMESPACE,
      userId: USER,
      type: sample.type,
      content: sample.content,
      tags: sample.tags,
      importance: sample.importance,
      source: { sessionId: "seed", messageId: null },
    });
  }
  console.log(
    `Seeded ${SAMPLE_MEMORIES.length} memories for ${NAMESPACE}/${USER} (${embeddings.model}).`,
  );
} finally {
  await engram.close();
}
