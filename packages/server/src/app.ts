import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";
import {
  EngramError,
  forgetSchema,
  listMemoriesSchema,
  recallSchema,
  rememberSchema,
  type MemoryService,
  type Recall,
} from "@engram/core";

export interface AppOptions {
  service: Pick<MemoryService, "remember" | "forget" | "list">;
  apiKeys: Record<string, string>;
  recall?: Recall;
  logger?: boolean;
}

export async function buildApp(options: AppOptions) {
  const apiKeys = z
    .record(z.string().trim().min(1).max(128), z.string().min(32))
    .parse(options.apiKeys);
  if (
    !Object.keys(apiKeys).length ||
    new Set(Object.values(apiKeys)).size !== Object.keys(apiKeys).length
  )
    throw new Error("Configure a unique API key of at least 32 characters for each namespace.");
  const keys = Object.entries(apiKeys).map(([namespace, key]) => ({
    namespace,
    hash: createHash("sha256").update(key).digest(),
  }));
  const app = Fastify({
    logger: options.logger
      ? { redact: ["req.headers.authorization", "req.headers.x-api-key"] }
      : false,
    bodyLimit: 128 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "Engram Memory API", version: "0.1.0" },
      components: {
        securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    if (error instanceof EngramError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({
        error: {
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "Invalid request.",
        },
      });
    request.log.error(error);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  });
  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));
  await app.register(async (routes) => {
    const namespaces = new WeakMap<object, string>();
    routes.addHook("onRequest", async (request) => {
      const key = request.headers["x-api-key"];
      if (typeof key !== "string")
        throw new EngramError("UNAUTHORIZED", "A valid x-api-key header is required.", 401);
      const digest = createHash("sha256").update(key).digest();
      let namespace: string | undefined;
      for (const entry of keys)
        if (timingSafeEqual(digest, entry.hash)) namespace = entry.namespace;
      if (!namespace)
        throw new EngramError("UNAUTHORIZED", "A valid x-api-key header is required.", 401);
      namespaces.set(request, namespace);
    });
    const checkNamespace = (request: object, requested: string): void => {
      if (requested !== namespaces.get(request))
        throw new EngramError("FORBIDDEN", "Namespace does not match the API key.", 403);
    };
    const schema = (input: z.ZodType, summary: string) => ({
      summary,
      security: [{ apiKey: [] }],
      body: z.toJSONSchema(input, { target: "draft-7", io: "input" }),
    });
    routes.post(
      "/remember",
      { schema: schema(rememberSchema, "Write or update a memory") },
      async (request, reply) => {
        const input = rememberSchema.parse(request.body);
        checkNamespace(request, input.namespace);
        return reply.code(200).send(await options.service.remember(input));
      },
    );
    routes.post(
      "/recall",
      { schema: schema(recallSchema, "Recall the memories that best match a query") },
      async (request) => {
        const input = recallSchema.parse(request.body);
        checkNamespace(request, input.namespace);
        if (!options.recall)
          throw new EngramError(
            "RECALL_NOT_CONFIGURED",
            "Connect the Track B recall implementation to enable this endpoint.",
            501,
          );
        return options.recall({ ...input, since: input.since ? new Date(input.since) : undefined });
      },
    );
    routes.post(
      "/forget",
      { schema: schema(forgetSchema, "Delete a memory or all memories for a user") },
      async (request) => {
        const input = forgetSchema.parse(request.body);
        if ("namespace" in input) checkNamespace(request, input.namespace);
        return options.service.forget(input, { namespace: namespaces.get(request)! });
      },
    );
    routes.get(
      "/memories",
      {
        schema: {
          summary: "List memories with cursor pagination",
          security: [{ apiKey: [] }],
          querystring: z.toJSONSchema(listMemoriesSchema, { target: "draft-7", io: "input" }),
        },
      },
      async (request) => {
        const input = listMemoriesSchema.parse(request.query);
        checkNamespace(request, input.namespace);
        return options.service.list(input);
      },
    );
  });
  return app;
}
