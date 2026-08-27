/**
 * ==========================================================================
 * OPC UA Modeler — MCP Server (Streamable HTTP entry point)
 *
 * Web Standards (Request/Response) transport, for hosting the same tool set
 * as `index.ts` (stdio) behind an HTTP route — e.g. a Next.js route handler
 * so the server can be added as a claude.ai custom connector.
 *
 * Stateless: no session ID, no SSE resumability — each request creates its
 * own McpServer + transport pair. Simple, and fine for our tool set (no
 * long-running/streaming tool calls, no server-initiated notifications).
 * ==========================================================================
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type RequestContext, withRequestContext } from "./cloud.js";
import { createServer } from "./server.js";

export type { RequestContext };

/**
 * POST carries JSON-RPC; the other two verbs the Streamable HTTP spec defines
 * only mean something with sessions, which stateless mode does not have:
 *
 * - GET opens the standalone SSE channel for server-initiated notifications.
 *   Here the transport is per-request and nothing else holds a reference, so
 *   no message could ever reach that stream — and `transport.close()` below
 *   would tear it down before the client read a byte anyway.
 * - DELETE terminates a session; there is none to terminate.
 *
 * The spec's guidance for a server that does not offer these is 405, so say
 * so directly instead of handing back a stream that dies on arrival.
 */
function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: this MCP endpoint is stateless and only accepts POST" },
      id: null
    }),
    { status: 405, headers: { "Content-Type": "application/json", Allow: "POST" } }
  );
}

/**
 * Handle one MCP-over-HTTP request and return the response. Mount this behind
 * any route that can hand you a standard `Request` and return a standard
 * `Response` (Next.js route handlers, Cloudflare Workers, Deno, Bun, Hono...).
 *
 * `context` lets a host that runs this server in-process alongside the API it
 * proxies to redirect those calls and attribute them to the real end user —
 * see {@link RequestContext}. Omit it for the plain stdio-equivalent behavior.
 */
export async function handleMcpHttpRequest(request: Request, context?: RequestContext): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    // Our tools are all fast request/response calls, so a plain JSON body is
    // simpler and more broadly compatible than SSE. It also makes the
    // `close()` below safe: the body is fully materialised before
    // `handleRequest` resolves, whereas an SSE response would still be
    // streaming and would be truncated.
    enableJsonResponse: true
  });

  await server.connect(transport);
  const response = context
    ? await withRequestContext(context, () => transport.handleRequest(request))
    : await transport.handleRequest(request);
  await transport.close();
  return response;
}
