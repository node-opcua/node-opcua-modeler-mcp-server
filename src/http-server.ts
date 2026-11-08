/**
 * ==========================================================================
 * OPC UA Modeler — MCP Server (standalone HTTP host)
 *
 * A plain `node:http` server around `handleMcpHttpRequest`, so the server can
 * be self-hosted and registered as a remote streamable-HTTP connector (Mistral
 * connectors, claude.ai custom connectors...) without a framework.
 *
 *   POST /mcp     MCP JSON-RPC (stateless, JSON responses)
 *   GET  /health  {"ok":true}, never gated
 *
 * Env:
 *   PORT                  listen port (default 8807), bound on 0.0.0.0
 *   MCP_HTTP_AUTH_TOKEN   if set, /mcp requires `Authorization: Bearer <token>`
 *   MCP_HTTP_CORS=1       add permissive CORS headers (off: the reverse proxy
 *                         is expected to own them)
 *
 * File access stays off: a path sent over HTTP would name a file on THIS
 * host. `handleMcpHttpRequest` already builds the server that way.
 * ==========================================================================
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleMcpHttpRequest } from "./http.js";

export const DEFAULT_PORT = 8807;

export interface HttpServerOptions {
  /** Bearer token required on /mcp; undefined allows anonymous access. */
  authToken?: string;
  /** Add permissive CORS headers and answer preflight on /mcp. */
  cors?: boolean;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id"
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Constant-time compare, so the token cannot be guessed byte by byte. */
function isAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The first hop of X-Forwarded-For (set by the reverse proxy), else the socket peer. */
function clientIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || undefined;
}

/** Node `IncomingMessage` → Web `Request`. */
function toWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    // required by undici whenever the body is a stream
    ...(hasBody ? { duplex: "half" } : {})
  } as RequestInit);
}

/** Web `Response` → Node `ServerResponse`; streams, so SSE bodies pass through too. */
async function sendWebResponse(res: ServerResponse, response: Response, extra: Record<string, string>): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, { ...headers, ...extra });
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}

/** Build (not start) the HTTP server. */
export function createMcpHttpServer(options: HttpServerOptions = {}): Server {
  const cors = options.cors ? CORS_HEADERS : {};

  return createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      if (path === "/health") {
        sendJson(res, req.method === "GET" || req.method === "HEAD" ? 200 : 405, { ok: true });
        return;
      }
      if (path !== "/mcp") {
        sendJson(res, 404, { error: "Not Found" });
        return;
      }
      if (req.method === "OPTIONS" && options.cors) {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (options.authToken && !isAuthorized(req.headers.authorization, options.authToken)) {
        sendJson(
          res,
          401,
          { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
          { "WWW-Authenticate": 'Bearer realm="mcp"', ...cors }
        );
        return;
      }
      // Forward the caller's IP so the hosted API rate-limits per user,
      // not per container.
      const ip = clientIp(req);
      const response = await handleMcpHttpRequest(
        toWebRequest(req),
        ip ? { forwardHeaders: { "x-forwarded-for": ip } } : undefined
      );
      await sendWebResponse(res, response, cors);
    } catch (err) {
      console.error("MCP HTTP request failed:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, cors);
      } else {
        res.end();
      }
    }
  });
}

/**
 * Start listening and install SIGTERM/SIGINT handlers that stop accepting
 * connections, close the open ones, and exit.
 */
export function startMcpHttpServer(env: NodeJS.ProcessEnv = process.env): Server {
  const port = Number(env.PORT) || DEFAULT_PORT;
  const authToken = env.MCP_HTTP_AUTH_TOKEN || undefined;
  const server = createMcpHttpServer({ authToken, cors: env.MCP_HTTP_CORS === "1" });

  server.listen(port, "0.0.0.0", () => {
    // never log the token itself
    console.error(
      `opcua-modeler MCP server listening on http://0.0.0.0:${port}/mcp (auth: ${authToken ? "bearer token" : "anonymous"})`
    );
  });

  const shutdown = (signal: string) => {
    console.error(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeAllConnections();
    // safety net if a socket refuses to close
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return server;
}
