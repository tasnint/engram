/**
 * Dashboard server: the JSON API under /api, plus the React app.
 * In development Vite runs inside this process (one port, hot reload).
 * In production (pnpm build && pnpm start) it serves the built files from dist/.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, embeddingFromEnvironment } from "@engram/core";
import { createApi } from "./api.js";

const port = Number(process.env.DASHBOARD_PORT ?? 4317);
const production = process.env.NODE_ENV === "production";
const root = fileURLToPath(new URL("..", import.meta.url));

const engram = await connect();
const api = createApi(engram, embeddingFromEnvironment());

let webHandler: (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;
if (production) {
  webHandler = (req, res) => void serveStatic(req.url ?? "/", res);
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    configFile: join(root, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });
  webHandler = (req, res) => vite.middlewares(req, res);
}

const server = createServer((req, res) => {
  api(req, res)
    .then((handled) => {
      if (!handled) webHandler(req, res);
    })
    .catch((error) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Engram dashboard: http://localhost:${port}`);
});

const shutdown = async () => {
  server.close();
  await engram.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

async function serveStatic(urlPath: string, res: import("node:http").ServerResponse) {
  const dist = join(root, "dist");
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0] ?? "/")).replace(
    /^(\.\.[/\\])+/,
    "",
  );
  const file = join(dist, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(dist)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res
      .writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
      .end(body);
  } catch {
    // Unknown paths get the app, which handles its own views.
    const body = await readFile(join(dist, "index.html"));
    res.writeHead(200, { "content-type": TYPES[".html"]! }).end(body);
  }
}
