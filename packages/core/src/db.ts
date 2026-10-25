import { MongoClient, type Collection, type Db } from "mongodb";
import { DEFAULT_DB_NAME, DEFAULT_MONGODB_URI, MEMORIES_COLLECTION } from "./config.js";
import type { MemoryDoc } from "./types.js";

export interface EngramDb {
  client: MongoClient;
  db: Db;
  memories: Collection<MemoryDoc>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  uri?: string;
  dbName?: string;
}

/** Connects using MONGODB_URI / ENGRAM_DB from the environment unless overridden. */
export async function connect(options: ConnectOptions = {}): Promise<EngramDb> {
  const uri = options.uri ?? process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI;
  const dbName = options.dbName ?? process.env.ENGRAM_DB ?? DEFAULT_DB_NAME;
  const client = await new MongoClient(uri, { appName: "engram" }).connect();
  const db = client.db(dbName);
  return {
    client,
    db,
    memories: db.collection<MemoryDoc>(MEMORIES_COLLECTION),
    close: () => client.close(),
  };
}
