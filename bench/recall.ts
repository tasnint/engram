/**
 * pnpm bench:recall [distractors]: recall quality and latency (X2, Track B).
 *
 * Loads the 16 sample memories for one user, plus distractor memories (some
 * for the same user, most for other users, so the indexes have realistic
 * size), into a separate database (engram_bench). Then asks 24 questions with
 * a known right answer, through every search method, and reports:
 *   - hit@1 / hit@3: how often the right memory is first / in the top 3
 *   - MRR: mean of 1/rank of the right memory (1.0 = always first)
 *   - p50 / p95 latency of a full recall() call
 *   - approximate (HNSW) vs exact vector search latency
 *
 * Needs mongot (pnpm db:up) and uses the embedding model from .env.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { MongoClient, ObjectId } from "mongodb";
import {
  DEFAULT_MONGODB_URI,
  MEMORIES_COLLECTION,
  MemoryService,
  SAMPLE_MEMORIES,
  VECTOR_INDEX_NAME,
  contentHash,
  embeddingFromEnvironment,
  ensureSearchIndexes,
  initializeDatabase,
  recall,
  waitForSearchIndexes,
  type MemoryDoc,
  type RecallOptions,
  type RecallMode,
  type StoredMemory,
} from "@engram/core";

const DISTRACTORS = Number(process.argv[2] ?? 5000);
const SAME_USER_DISTRACTORS = 300;
const RUNS_PER_QUERY = 5;
const NAMESPACE = "bench-agent";
const USER = "u_bench";
const DAY = 24 * 60 * 60 * 1000;

/** Each question and a phrase that appears only in its right answer. */
const QUESTIONS: Array<{ query: string; answer: string; style: "keyword" | "paraphrase" }> = [
  { query: "what food should I avoid", answer: "peanuts", style: "paraphrase" },
  { query: "does the user have any allergies", answer: "peanuts", style: "paraphrase" },
  {
    query: "which programming language should code samples use",
    answer: "Python over JavaScript",
    style: "paraphrase",
  },
  { query: "how long should my replies be", answer: "bullet points", style: "paraphrase" },
  { query: "what does the user do for a living", answer: "backend engineer", style: "paraphrase" },
  { query: "which city are they based in", answer: "Austin", style: "paraphrase" },
  { query: "do they have any pets", answer: "corgi", style: "paraphrase" },
  { query: "why did the release break this week", answer: "old image tag", style: "paraphrase" },
  {
    query: "how does their team ship to production",
    answer: "Kubernetes on Google Cloud",
    style: "paraphrase",
  },
  {
    query: "what datastore do they run at the company",
    answer: "three-node replica set",
    style: "paraphrase",
  },
  { query: "how was the sluggish report fixed", answer: "compound index", style: "paraphrase" },
  { query: "upcoming job interview practice", answer: "rate limiters", style: "paraphrase" },
  { query: "holiday plans and restaurants", answer: "San Antonio", style: "paraphrase" },
  {
    query: "streaming database updates to another system",
    answer: "change streams",
    style: "paraphrase",
  },
  { query: "hobby they study on Saturdays", answer: "Go concurrency", style: "paraphrase" },
  { query: "color theme for the IDE", answer: "dark mode", style: "paraphrase" },
  { query: "Ledgerly", answer: "backend engineer", style: "keyword" },
  { query: "Biscuit", answer: "corgi", style: "keyword" },
  { query: "rate limiters", answer: "rate limiters", style: "keyword" },
  { query: "Secret Manager", answer: "rotate API keys", style: "keyword" },
  { query: "Helm image tag", answer: "old image tag", style: "keyword" },
  { query: "Central time zone", answer: "Austin", style: "keyword" },
  { query: "compound index userId createdAt", answer: "compound index", style: "keyword" },
  { query: "peanuts", answer: "peanuts", style: "keyword" },
];

/** Neutral filler topics, chosen not to overlap with any question. */
const DISTRACTOR_PARTS = {
  verbs: [
    "Read an article about",
    "Watched a video on",
    "Asked a question about",
    "Bookmarked a guide to",
    "Took notes on",
    "Mentioned",
    "Compared two options for",
    "Spent the afternoon on",
  ],
  topics: [
    "houseplant watering",
    "sourdough starters",
    "bike tire pressure",
    "chess openings",
    "birdwatching gear",
    "knitting patterns",
    "board game rules",
    "photography lighting",
    "marathon pacing",
    "tea brewing",
    "origami cranes",
    "jazz chord voicings",
    "woodworking joints",
    "astronomy apps",
    "podcast editing",
    "home espresso grinders",
    "calligraphy pens",
    "aquarium filters",
    "rock climbing shoes",
    "vinyl record care",
  ],
  tails: [
    "for a friend",
    "last weekend",
    "out of curiosity",
    "for a side project",
    "during lunch",
    "on the train",
    "with a neighbor",
    "after work",
  ],
};

function distractor(i: number): string {
  const { verbs, topics, tails } = DISTRACTOR_PARTS;
  return `${verbs[i % verbs.length]} ${topics[Math.floor(i / verbs.length) % topics.length]} ${tails[Math.floor(i / (verbs.length * topics.length)) % tails.length]} (#${i})`;
}

type Method = { name: string; mode: RecallMode; options: RecallOptions };
const METHODS: Method[] = [
  { name: "Keywords only ($search)", mode: "text", options: {} },
  { name: "Meaning only ($vectorSearch)", mode: "vector", options: {} },
  { name: "Hybrid, rank fusion (RRF, in app)", mode: "hybrid", options: { fusionMethod: "rank" } },
  { name: "Hybrid, $rankFusion (in MongoDB)", mode: "hybrid", options: { fusion: "server" } },
  { name: "Hybrid, score fusion (default)", mode: "hybrid", options: { fusionMethod: "score" } },
];

const embeddings = embeddingFromEnvironment();
const client = await new MongoClient(process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI).connect();
const db = client.db("engram_bench");
try {
  console.log(
    `Model: ${embeddings.model} (${embeddings.dimensions} dims). Distractors: ${DISTRACTORS}.`,
  );
  await db.dropDatabase();
  await initializeDatabase(db, embeddings);
  await ensureSearchIndexes(db, { dimensions: embeddings.dimensions });
  const memories = db.collection<MemoryDoc>(MEMORIES_COLLECTION);
  await waitForSearchIndexes(memories);

  // The 16 real memories go through remember(), like production writes.
  const now = Date.now();
  for (const sample of SAMPLE_MEMORIES) {
    await new MemoryService(db, {
      embeddings,
      now: () => new Date(now - sample.daysAgo * DAY),
    }).remember({
      namespace: NAMESPACE,
      userId: USER,
      type: sample.type,
      content: sample.content,
      tags: sample.tags,
      importance: sample.importance,
    });
  }

  // Distractors are bulk-inserted for speed.
  process.stdout.write("Embedding distractors... ");
  const texts = Array.from({ length: DISTRACTORS }, (_, i) => distractor(i));
  const stored = db.collection<StoredMemory>(MEMORIES_COLLECTION);
  for (let start = 0; start < texts.length; start += 256) {
    const batch = texts.slice(start, start + 256);
    const vectors = await embeddings.embed(batch, "document");
    await stored.insertMany(
      batch.map((content, j) => {
        const i = start + j;
        const at = new Date(now - (i % 180) * DAY);
        return {
          _id: new ObjectId(),
          namespace: NAMESPACE,
          userId: i < SAME_USER_DISTRACTORS ? USER : `u_other_${i % 200}`,
          type: (["fact", "episode", "preference"] as const)[i % 3]!,
          content,
          embedding: vectors[j]!,
          tags: [],
          importance: 0.5,
          accessCount: 0,
          lastAccessedAt: at,
          createdAt: at,
          expiresAt: null,
          status: "active" as const,
          source: { sessionId: null, messageId: null },
          consolidatedInto: null,
          contentHash: contentHash(content),
          decayAt: at,
        };
      }),
    );
  }
  console.log("done.");

  process.stdout.write("Waiting for mongot to index everything... ");
  const total = SAMPLE_MEMORIES.length + DISTRACTORS;
  for (const deadline = Date.now() + 300_000; ;) {
    const [meta] = await memories
      .aggregate<{ count: { total: number } }>([
        {
          $searchMeta: {
            index: "memories_text",
            exists: { path: "content" },
            count: { type: "total" },
          },
        },
      ])
      .toArray();
    if ((meta?.count.total ?? 0) >= total) break;
    if (Date.now() > deadline) throw new Error("mongot didn't finish indexing in 5 minutes");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 3000)); // vector index syncs separately
  console.log("done.\n");

  const deps = { memories, embedder: embeddings };
  const qualityRows = [];
  for (const method of METHODS) {
    let hit1 = 0;
    let hit3 = 0;
    let rr = 0;
    const byStyle = { keyword: 0, paraphrase: 0 };
    const misses: string[] = [];
    const latencies: number[] = [];
    for (const q of QUESTIONS) {
      let results: Awaited<ReturnType<typeof recall>> = [];
      for (let run = 0; run < RUNS_PER_QUERY; run++) {
        const started = performance.now();
        results = await recall(
          deps,
          { namespace: NAMESPACE, userId: USER, query: q.query, k: 10, mode: method.mode },
          { ...method.options, trackAccess: false },
        );
        latencies.push(performance.now() - started);
      }
      const rank = results.findIndex((r) => r.memory.content.includes(q.answer)) + 1;
      if (rank === 1) {
        hit1++;
        byStyle[q.style]++;
      } else misses.push(`${q.query} → ${rank || "not in top 10"}`);
      if (rank >= 1 && rank <= 3) hit3++;
      if (rank > 0) rr += 1 / rank;
    }
    latencies.sort((a, b) => a - b);
    const pct = (p: number) =>
      latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!;
    const n = QUESTIONS.length;
    const keywordN = QUESTIONS.filter((q) => q.style === "keyword").length;
    qualityRows.push({
      method: method.name,
      hit1: hit1 / n,
      hit3: hit3 / n,
      mrr: rr / n,
      keywordHit1: byStyle.keyword / keywordN,
      paraphraseHit1: byStyle.paraphrase / (n - keywordN),
      p50: pct(0.5),
      p95: pct(0.95),
      misses,
    });
  }

  // Approximate (HNSW graph) vs exact (scan every vector) nearest neighbors.
  const [probe] = await embeddings.embed(["what food should I avoid"], "query");
  const vectorLatency = async (exact: boolean) => {
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      await memories
        .aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEX_NAME,
              path: "embedding",
              queryVector: probe!,
              limit: 20,
              ...(exact ? { exact: true } : { numCandidates: 300 }),
              filter: { namespace: NAMESPACE },
            },
          },
          { $project: { _id: 1 } },
        ])
        .toArray();
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return { p50: times[25]!, p95: times[47]! };
  };
  const ann = await vectorLatency(false);
  const enn = await vectorLatency(true);

  const f = (x: number) => x.toFixed(2);
  const pctf = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `Model: ${embeddings.model} (${embeddings.dimensions} dims) · ${total} memories in the index (${SAME_USER_DISTRACTORS} distractors for the same user) · ${QUESTIONS.length} questions × ${RUNS_PER_QUERY} runs`,
    "",
    "| Method | Hit@1 | Hit@3 | MRR | Hit@1, keyword questions | Hit@1, paraphrased questions | p50 | p95 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...qualityRows.map(
      (r) =>
        `| ${r.method} | ${pctf(r.hit1)} | ${pctf(r.hit3)} | ${f(r.mrr)} | ${pctf(r.keywordHit1)} | ${pctf(r.paraphraseHit1)} | ${r.p50.toFixed(1)} ms | ${r.p95.toFixed(1)} ms |`,
    ),
    "",
    "| Vector search over the namespace | p50 | p95 |",
    "| --- | --- | --- |",
    `| Approximate (HNSW, numCandidates 300) | ${ann.p50.toFixed(1)} ms | ${ann.p95.toFixed(1)} ms |`,
    `| Exact (scans every vector) | ${enn.p50.toFixed(1)} ms | ${enn.p95.toFixed(1)} ms |`,
  ];
  console.log(lines.join("\n"));
  console.log("\nMisses (question → rank of the right memory):");
  for (const r of qualityRows)
    if (r.misses.length) console.log(`  ${r.method}: ${r.misses.join("; ")}`);

  await mkdir(new URL("./results/", import.meta.url), { recursive: true });
  const file = new URL(
    `./results/recall-${new Date().toISOString().slice(0, 10)}.json`,
    import.meta.url,
  );
  await writeFile(
    file,
    JSON.stringify({ model: embeddings.model, total, qualityRows, ann, enn }, null, 2),
  );
  console.log(`\nSaved ${file.pathname}`);
} finally {
  await db.dropDatabase().catch(() => {});
  await client.close();
}
