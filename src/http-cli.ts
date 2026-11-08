#!/usr/bin/env node
/**
 * ==========================================================================
 * OPC UA Modeler — MCP Server (HTTP CLI Entry Point)
 *
 * `node-opcua-modeler-mcp-http`, or `node-opcua-modeler-mcp --http`.
 * Serves the same tools as the stdio entry point over streamable HTTP; see
 * http-server.ts for the env vars.
 * ==========================================================================
 */

import { startMcpHttpServer } from "./http-server.js";

startMcpHttpServer();
