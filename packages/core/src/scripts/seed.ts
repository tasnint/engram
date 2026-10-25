/**
 * pnpm db:seed — loads sample memories for user "u_demo" of agent "demo-agent".
 * Re-running replaces the previous sample data. Inserts directly instead of
 * going through remember(), so it works before A2 lands.
 */
import { ObjectId } from "mongodb";
import { connect } from "../db.js";
import { createEmbedderFromEnv } from "../embeddings/index.js";
import type { MemoryDoc, MemoryType } from "../types.js";

const NAMESPACE = "demo-agent";
const USER = "u_demo";
const DAY = 24 * 60 * 60 * 1000;

const samples: Array<{
  type: MemoryType;
  content: string;
  tags: string[];
  importance: number;
  daysAgo: number;
}> = [
  {
    type: "preference",
    content: "Prefers code examples in Python over JavaScript",
    tags: ["coding", "language"],
    importance: 0.8,
    daysAgo: 40,
  },
  {
    type: "preference",
    content: "Wants short answers with bullet points, no long intros",
    tags: ["style"],
    importance: 0.7,
    daysAgo: 12,
  },
  {
    type: "preference",
    content: "Uses dark mode in every editor and asks for dark-friendly color palettes",
    tags: ["design"],
    importance: 0.3,
    daysAgo: 60,
  },
  {
    type: "fact",
    content: "Works as a backend engineer at a fintech startup called Ledgerly",
    tags: ["work"],
    importance: 0.9,
    daysAgo: 90,
  },
  {
    type: "fact",
    content: "Their team deploys to Kubernetes on Google Cloud using Helm charts",
    tags: ["work", "infra"],
    importance: 0.6,
    daysAgo: 30,
  },
  {
    type: "fact",
    content: "The main database at work is MongoDB 9 with a three-node replica set",
    tags: ["work", "database"],
    importance: 0.7,
    daysAgo: 25,
  },
  {
    type: "fact",
    content: "Lives in Austin and is in the Central time zone",
    tags: ["personal"],
    importance: 0.5,
    daysAgo: 100,
  },
  {
    type: "fact",
    content: "Allergic to peanuts",
    tags: ["personal", "health"],
    importance: 0.9,
    daysAgo: 200,
  },
  {
    type: "fact",
    content: "Has a dog named Biscuit who is a corgi",
    tags: ["personal"],
    importance: 0.4,
    daysAgo: 150,
  },
  {
    type: "episode",
    content: "Deploy failed on Tuesday because the Helm chart pinned an old image tag",
    tags: ["infra", "incident"],
    importance: 0.6,
    daysAgo: 6,
  },
  {
    type: "episode",
    content:
      "Debugged a slow aggregation query; adding a compound index on userId and createdAt fixed it",
    tags: ["database"],
    importance: 0.7,
    daysAgo: 3,
  },
  {
    type: "episode",
    content: "Asked for help preparing for a system design interview about rate limiters",
    tags: ["career"],
    importance: 0.5,
    daysAgo: 9,
  },
  {
    type: "episode",
    content: "Planned a weekend trip to San Antonio and wanted vegetarian restaurant ideas",
    tags: ["travel", "food"],
    importance: 0.3,
    daysAgo: 20,
  },
  {
    type: "episode",
    content: "Wrote a Python script to rotate API keys stored in Google Secret Manager",
    tags: ["coding", "security"],
    importance: 0.5,
    daysAgo: 2,
  },
  {
    type: "episode",
    content: "Set up change streams to sync orders from MongoDB into a search service",
    tags: ["database"],
    importance: 0.6,
    daysAgo: 15,
  },
  {
    type: "fact",
    content: "Is learning Go on weekends and is halfway through a Go concurrency course",
    tags: ["coding", "learning"],
    importance: 0.5,
    daysAgo: 18,
  },
];

const embedder = createEmbedderFromEnv();
const engram = await connect();
try {
  const vectors = await embedder.embed(
    samples.map((s) => s.content),
    "document",
  );
  const now = Date.now();
  const docs: MemoryDoc[] = samples.map((s, i) => {
    const createdAt = new Date(now - s.daysAgo * DAY);
    return {
      _id: new ObjectId(),
      namespace: NAMESPACE,
      userId: USER,
      type: s.type,
      content: s.content,
      embedding: vectors[i]!,
      tags: s.tags,
      importance: s.importance,
      accessCount: 0,
      lastAccessedAt: createdAt,
      createdAt,
      expiresAt: null,
      status: "active",
      source: { sessionId: "seed" },
      consolidatedInto: null,
    };
  });
  await engram.memories.deleteMany({ namespace: NAMESPACE, userId: USER });
  await engram.memories.insertMany(docs);
  console.log(`Seeded ${docs.length} memories for ${NAMESPACE}/${USER} (${embedder.model}).`);
} finally {
  await engram.close();
}
