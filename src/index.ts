#!/usr/bin/env node
/**
 * ==========================================================================
 * OPC UA Modeler — MCP Server (CLI Entry Point)
 *
 * Thin wrapper that creates the server and connects it to stdio transport.
 * All tool registration logic lives in server.ts.
 *
 * Transport: stdio (JSON-RPC over stdin/stdout)
 * IMPORTANT: Never use console.log() — stdout is reserved for JSON-RPC.
 * ==========================================================================
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("opcua-modeler MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
