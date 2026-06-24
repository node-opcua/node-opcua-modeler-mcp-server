/**
 * ==========================================================================
 * OPC UA Modeler — MCP Server Factory (IP-Safe Version)
 *
 * Creates and configures the MCP server with 6 OPC UA companion-spec
 * discovery tools. All data comes from a static catalog.json file —
 * ZERO dependencies on proprietary @sterfive/* packages.
 *
 * Architecture: "Thin Local Shell" per Project Prometheus §1.1
 * - Local tools: query the static type catalog (free, offline)
 * - Cloud tools: proxy to api.opcua-modeler.sterfive.io (Phase 1b)
 *
 * IMPORTANT: Never use console.log() — stdout may be reserved for JSON-RPC.
 * ==========================================================================
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findEngineeringUnit,
  getTypeDetails,
  listNamespaces,
  listTypes,
  resolveDependencies,
  searchTypes
} from "./catalog.js";

// Re-export for testing
export { findEngineeringUnit, getTypeDetails, listNamespaces, listTypes, resolveDependencies, searchTypes };

/** Tool name type */
export type ToolName =
  | "resolve_dependencies"
  | "list_namespaces"
  | "list_types"
  | "get_type_details"
  | "search_types"
  | "find_engineering_unit";

/**
 * Direct tool call handler for testing (bypasses MCP protocol).
 * Returns the same shape as MCP tool responses.
 */
export async function handleToolCall(name: ToolName, args: Record<string, unknown>) {
  try {
    switch (name) {
      case "resolve_dependencies": {
        const aliases = args.aliases as string[];
        return { content: [{ type: "text" as const, text: JSON.stringify(resolveDependencies(aliases)) }] };
      }
      case "list_namespaces": {
        const specs = listNamespaces().map((s) => ({
          alias: s.alias,
          name: s.name,
          uri: s.uri,
          dependencies: s.deps
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(specs) }] };
      }
      case "list_types": {
        return { content: [{ type: "text" as const, text: JSON.stringify(listTypes(args.alias as string)) }] };
      }
      case "get_type_details": {
        const details = getTypeDetails(args.alias as string, args.browseName as string);
        if (!details) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Type not found` }) }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }] };
      }
      case "search_types": {
        return { content: [{ type: "text" as const, text: JSON.stringify(searchTypes(args.query as string)) }] };
      }
      case "find_engineering_unit": {
        const result = findEngineeringUnit(String(args.query ?? ""));
        if (!result) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No unit found` }) }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      default:
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
  }
}

/**
 * Create and configure the MCP server with all OPC UA tools registered.
 * The server is NOT connected to any transport — the caller is responsible
 * for connecting it (e.g., StdioServerTransport or InMemoryTransport).
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "opcua-modeler",
    version: "1.0.0"
  });

  // ── 1. resolve_dependencies ──────────────────────────────────────────

  server.tool(
    "resolve_dependencies",
    "Given one or more companion spec namespace aliases, returns the full " +
      "resolved dependency list that MUST go in the YAML `namespaces:` section. " +
      "Always call this before generating the namespaces block.",
    { aliases: z.array(z.string()).describe('Companion spec aliases to resolve (e.g. ["machineTool", "robotics"])') },
    async ({ aliases }) => {
      try {
        const resolved = resolveDependencies(aliases);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(resolved) }]
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }],
          isError: true
        };
      }
    }
  );

  // ── 2. list_namespaces ───────────────────────────────────────────────

  server.tool(
    "list_namespaces",
    "List all well-known OPC UA companion spec namespace aliases with their " +
      "full names, URIs, and dependencies. Use this to discover what namespaces are available.",
    {},
    async () => {
      const specs = listNamespaces().map((s) => ({
        alias: s.alias,
        name: s.name,
        uri: s.uri,
        dependencies: s.deps
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(specs) }]
      };
    }
  );

  // ── 3. list_types ────────────────────────────────────────────────────

  server.tool(
    "list_types",
    "List ALL ObjectTypes, VariableTypes, and InterfaceTypes defined in a " +
      "specific companion spec namespace. " +
      "ALWAYS call this before using any type from a namespace — NEVER guess type names.",
    { alias: z.string().describe('Companion spec alias (e.g. "machinery", "di", "robotics")') },
    async ({ alias }) => {
      const types = listTypes(alias);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(types) }]
      };
    }
  );

  // ── 4. get_type_details ──────────────────────────────────────────────

  server.tool(
    "get_type_details",
    "Get detailed information about a specific type: its components, properties, " +
      "methods, interfaces, and optional members. Use this to understand a type's " +
      "structure before creating instances or subtypes.",
    {
      alias: z.string().describe('Companion spec alias where the type is defined (e.g. "machinery")'),
      browseName: z.string().describe('The type browse name (e.g. "MachineryItemIdentificationType")')
    },
    async ({ alias, browseName }) => {
      const details = getTypeDetails(alias, browseName);
      if (!details) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Type "${browseName}" not found in "${alias}"` }) }],
          isError: true
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }]
      };
    }
  );

  // ── 5. search_types ──────────────────────────────────────────────────

  server.tool(
    "search_types",
    "Search for types across ALL companion specs by keyword. " +
      "Use this when you don't know which namespace defines a type. " +
      "Returns matching types with their namespace alias.",
    { query: z.string().describe('Search keyword (e.g. "identification", "temperature", "motion")') },
    async ({ query }) => {
      const results = searchTypes(query);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results) }]
      };
    }
  );

  // ── 6. find_engineering_unit ──────────────────────────────────────────

  server.tool(
    "find_engineering_unit",
    "Find the official UNECE Rec. 20 engineering unit symbol for a given description. " +
      "ALWAYS call this before using any engineering unit — NEVER guess unit symbols.",
    { query: z.string().describe('Description or common name of the unit (e.g. "revolutions per minute", "celsius", "pressure bar")') },
    async ({ query }) => {
      const result = findEngineeringUnit(query);
      if (!result) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `No unit found for "${query}"` }) }],
          isError: true
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }]
      };
    }
  );

  return server;
}
