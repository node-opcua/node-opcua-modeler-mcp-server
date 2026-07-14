/**
 * ==========================================================================
 * OPC UA Modeler — MCP Server Factory (IP-Safe Version)
 *
 * Creates and configures the MCP server with 10 OPC UA tools:
 * - 6 LOCAL tools: query the static type catalog (free, offline)
 * - 4 CLOUD tools: proxy to api.opcua-modeler.sterfive.io
 *
 * Architecture: "Thin Local Shell" per Project Prometheus §1.1
 * ZERO dependencies on proprietary @sterfive/* packages.
 *
 * IMPORTANT: Never use console.log() — stdout may be reserved for JSON-RPC.
 * ==========================================================================
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findEngineeringUnit, getTypeDetails, listNamespaces, listTypes, resolveDependencies, searchTypes } from "./catalog.js";
import { cloudFetch, formatCloudError } from "./cloud.js";

// Re-export for testing
export { findEngineeringUnit, getTypeDetails, listNamespaces, listTypes, resolveDependencies, searchTypes };

/** Tool name type */
export type ToolName =
  | "resolve_dependencies"
  | "list_namespaces"
  | "list_types"
  | "get_type_details"
  | "search_types"
  | "find_engineering_unit"
  | "opcua_model_validate"
  | "opcua_model_generate"
  | "opcua_model_reverse"
  | "opcua_model_create";

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
    version: "1.2.0"
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
    {
      query: z
        .string()
        .describe('Description or common name of the unit (e.g. "revolutions per minute", "celsius", "pressure bar")')
    },
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

  // ═══════════════════════════════════════════════════════════════════════
  // CLOUD TOOLS — proxy to api.opcua-modeler.sterfive.io (Phase 1b)
  // These require the SaaS API to be running. Set OPCUA_MODELER_API_KEY
  // in env for authenticated access (generate/reverse require a key).
  // ═══════════════════════════════════════════════════════════════════════

  // ── 7. opcua_model_validate ───────────────────────────────────────────

  server.tool(
    "opcua_model_validate",
    "Validate an OPC UA YAML model for correctness. Returns diagnostics " +
      "with severity (error/warning/info), codes, messages, and line numbers. " +
      "Works without an API key (limited to 5 calls/day). " +
      "ALWAYS validate before generating.",
    {
      yaml: z.string().describe("The full YAML model source to validate")
    },
    async ({ yaml }) => {
      const result = await cloudFetch<{
        valid: boolean;
        diagnostics: Array<{ severity: string; code: string; message: string; line?: number }>;
      }>("/api/v1/validate", yaml, "text/yaml");

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: formatCloudError(result.error) }],
          isError: true
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }]
      };
    }
  );

  // ── 8. opcua_model_generate ───────────────────────────────────────────

  server.tool(
    "opcua_model_generate",
    "Generate OPC UA NodeSet2.xml and Symbols.CSV from a YAML model. " +
      "Requires an API key (set OPCUA_MODELER_API_KEY env var). " +
      "Returns base64-encoded artifacts if the model is valid, " +
      "or diagnostics if validation fails. " +
      "Optionally set include_docs=true to also generate markdown documentation.",
    {
      yaml: z.string().describe("The full YAML model source to generate from"),
      include_docs: z.boolean().optional().describe("Set to true to include markdown documentation (slower)")
    },
    async ({ yaml, include_docs }) => {
      const path = include_docs ? "/api/v1/generate?include=docs" : "/api/v1/generate";
      const result = await cloudFetch<{
        valid: boolean;
        artifacts?: {
          nodeset2_xml: string;
          symbols_csv: string;
          documentation_md?: string;
        };
        diagnostics: Array<{ severity: string; code: string; message: string; line?: number }>;
      }>(path, yaml, "text/yaml");

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: formatCloudError(result.error) }],
          isError: true
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }]
      };
    }
  );

  // ── 9. opcua_model_reverse ────────────────────────────────────────────

  server.tool(
    "opcua_model_reverse",
    "Reverse-engineer a NodeSet2.xml file back into the YAML DSL format. " +
      "Requires an API key (set OPCUA_MODELER_API_KEY env var). " +
      "Optionally specify the target namespace URI to extract.",
    {
      xml: z.string().describe("The NodeSet2.xml content to reverse-engineer"),
      namespace_uri: z.string().optional().describe("Target namespace URI to extract (auto-detected if omitted)")
    },
    async ({ xml, namespace_uri }) => {
      const path = namespace_uri ? `/api/v1/reverse?ns=${encodeURIComponent(namespace_uri)}` : "/api/v1/reverse";
      const result = await cloudFetch<{
        yaml: string;
        diagnostics: Array<{ severity: string; code: string; message: string }>;
      }>(path, xml, "application/xml");

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: formatCloudError(result.error) }],
          isError: true
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }]
      };
    }
  );

  // ── 10. opcua_model_create ─────────────────────────────────────────────

  server.tool(
    "opcua_model_create",
    "Generate an OPC UA YAML model from a natural language description " +
      "using AI. Requires an API key (set OPCUA_MODELER_API_KEY env var). " +
      "The AI will auto-detect relevant companion specs, generate a " +
      "validated model with documentation, and auto-correct validation errors.",
    {
      prompt: z.string().describe("Natural language description of the OPC UA model to generate"),
      forceSpecs: z.array(z.string()).optional().describe('Companion spec aliases to force (e.g. ["di", "ia"])')
    },
    async ({ prompt, forceSpecs }) => {
      const result = await cloudFetch<{
        success: boolean;
        yaml: string;
        attempts: number;
        diagnostics: Array<{ severity: string; code: string; message: string }>;
        model: string;
        tokens: { input: number; output: number };
      }>("/api/v1/ai/generate", JSON.stringify({ prompt, forceSpecs, stream: false }), "application/json");

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: formatCloudError(result.error) }],
          isError: true
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }]
      };
    }
  );

  return server;
}
