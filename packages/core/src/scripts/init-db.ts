/**
 * pnpm db:init: sets up everything the database needs. Safe to run repeatedly.
 *   A1: the memories collection with schema validation, B-tree and TTL indexes
 *   B1: the vector and full-text search indexes (needs mongot), waiting until ready
 */
import { connect } from "../db.js";
import { initializeDatabase } from "../database.js";
import { embeddingFromEnvironment } from "../embeddings/index.js";
import { ensureSearchIndexes, waitForSearchIndexes } from "../read/indexes.js";

const embeddings = embeddingFromEnvironment();
const engram = await connect();
try {
  await initializeDatabase(engram.db, embeddings);
  console.log(
    `Collection, schema and indexes ready for ${embeddings.model} (${embeddings.dimensions} dims).`,
  );
  const result = await ensureSearchIndexes(engram.db, { dimensions: embeddings.dimensions });
  console.log(`Search indexes: vector ${result.vector}, text ${result.text}.`);
  process.stdout.write("Waiting for search indexes to be ready... ");
  await waitForSearchIndexes(engram.memories);
  console.log("ready.");
} finally {
  await engram.close();
}
