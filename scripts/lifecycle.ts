import { MongoClient } from 'mongodb';
import {
  ChatCompletionSummarizer,
  consolidateEpisodes,
  decayImportance,
  embeddingFromEnvironment,
  initializeDatabase,
} from '@engram/core';

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
const action = process.argv[2];
if (!['decay', 'consolidate'].includes(action ?? ''))
  throw new Error('Usage: pnpm lifecycle <decay|consolidate> [namespace] [minimum-age-days]');
const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE ?? 'engram');
  const embeddings = embeddingFromEnvironment();
  await initializeDatabase(db, embeddings);
  if (action === 'decay') {
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
    if (
      !namespace ||
      !Number.isFinite(days) ||
      days <= 0 ||
      !process.env.SUMMARIZER_URL ||
      !process.env.SUMMARIZER_MODEL
    )
      throw new Error(
        'Set SUMMARIZER_URL and SUMMARIZER_MODEL, and supply a namespace and positive minimum age.',
      );
    const summarizer = new ChatCompletionSummarizer({
      url: process.env.SUMMARIZER_URL,
      model: process.env.SUMMARIZER_MODEL,
      apiKey: process.env.SUMMARIZER_API_KEY,
    });
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
