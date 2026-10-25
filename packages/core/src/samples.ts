/** Sample memories for pnpm db:seed, the demo and the recall benchmark. */
import type { MemoryType } from "./types.js";

export const SAMPLE_MEMORIES: Array<{
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
