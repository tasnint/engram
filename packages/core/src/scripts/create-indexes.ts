/** pnpm db:indexes — creates the memories collection and both search indexes, then waits until they're ready. */
import { connect } from "../db.js";
import { createEmbedderFromEnv } from "../embeddings/index.js";
import { ensureSearchIndexes, waitForSearchIndexes } from "../read/indexes.js";

const embedder = createEmbedderFromEnv();
const engram = await connect();
try {
  const result = await ensureSearchIndexes(engram.db, { dimensions: embedder.dimensions });
  console.log(
    `Vector index (${embedder.dimensions} dims, ${embedder.model}): ${result.vector}. Text index: ${result.text}.`,
  );
  process.stdout.write("Waiting for indexes to be ready... ");
  await waitForSearchIndexes(engram.memories);
  console.log("ready.");
} finally {
  await engram.close();
}
