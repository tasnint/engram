import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import type { ChangeStreamDocument } from "mongodb";
import type { MemoryDoc } from "@engram/core";
import {
  changeStreamPipeline,
  decodeResumeToken,
  encodeResumeToken,
  toFeedEvent,
} from "../server/events.js";

const id = new ObjectId();
const wallTime = new Date("2026-10-25T15:00:00Z");
const change = (c: object) =>
  ({
    _id: { _data: "abc" },
    documentKey: { _id: id },
    wallTime,
    ...c,
  }) as ChangeStreamDocument<MemoryDoc>;

describe("change stream feed", () => {
  it("never ships embeddings", () => {
    const hidden = changeStreamPipeline("bot")[1]!.$project;
    for (const field of ["embedding", "contentHash", "decayAt"]) {
      expect(hidden[`fullDocument.${field}`]).toBe(0);
      expect(hidden[`updateDescription.updatedFields.${field}`]).toBe(0);
    }
  });

  it("maps inserts, updates and deletes", () => {
    const doc = { _id: id, content: "x" };
    expect(toFeedEvent(change({ operationType: "insert", fullDocument: doc }))).toEqual({
      kind: "insert",
      id: id.toHexString(),
      at: wallTime.toISOString(),
      memory: doc,
    });
    expect(
      toFeedEvent(
        change({
          operationType: "update",
          fullDocument: doc,
          updateDescription: { updatedFields: { accessCount: 2, lastAccessedAt: wallTime } },
        }),
      ),
    ).toMatchObject({ kind: "update", changed: ["accessCount", "lastAccessedAt"] });
    expect(toFeedEvent(change({ operationType: "delete" }))).toEqual({
      kind: "delete",
      id: id.toHexString(),
      at: wallTime.toISOString(),
    });
  });

  it("skips updates whose document is already gone", () => {
    expect(
      toFeedEvent(change({ operationType: "update", updateDescription: { updatedFields: {} } })),
    ).toBeNull();
  });

  it("round-trips resume tokens and ignores garbage", () => {
    const token = { _data: "8263A1" };
    expect(decodeResumeToken(encodeResumeToken(token))).toEqual(token);
    expect(decodeResumeToken("%%%")).toBeUndefined();
    expect(decodeResumeToken(undefined)).toBeUndefined();
  });
});
