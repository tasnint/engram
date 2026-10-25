import type { Collection } from "mongodb";
import { recall, type RecallOptions } from "./read/recall.js";
import type { Embedder, EngramApi, MemoryDoc } from "./types.js";

export interface EngramDeps {
  memories: Collection<MemoryDoc>;
  embedder: Embedder;
  recallOptions?: RecallOptions;
}

export class NotImplementedError extends Error {
  override name = "NotImplementedError";
}

/** One object with all three operations, for the API server, MCP server and SDK to share. */
export function createEngram(deps: EngramDeps): EngramApi {
  return {
    recall: (input) => recall(deps, input, deps.recallOptions),
    // TODO(A2, Neha): replace with write/remember.ts
    remember: async () => {
      throw new NotImplementedError("remember() isn't implemented yet (Track A, A2)");
    },
    // TODO(A4, Neha): replace with write/forget.ts
    forget: async () => {
      throw new NotImplementedError("forget() isn't implemented yet (Track A, A4)");
    },
  };
}
