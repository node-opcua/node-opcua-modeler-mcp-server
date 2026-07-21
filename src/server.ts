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
import {
  findEngineeringUnit,
  findReusableBlock,
  getTypeDetails,
  listNamespaces,
  listTypes,
  resolveDependencies,
  searchTypes
} from "./catalog.js";
import { cloudFetch, formatCloudError } from "./cloud.js";

// Re-export for testing
export { findEngineeringUnit, findReusableBlock, getTypeDetails, listNamespaces, listTypes, resolveDependencies, searchTypes };

/** Tool name type */
export type ToolName =
  | "resolve_dependencies"
  | "list_namespaces"
  | "list_types"
  | "get_type_details"
  | "search_types"
  | "find_reusable_block"
  | "find_engineering_unit"
  | "opcua_model_validate"
  | "opcua_model_generate"
  | "opcua_model_reverse"
  | "opcua_model_create";

// ── Tool result helpers ──────────────────────────────────────────────────
// Shape matches the MCP CallToolResult (a text content block, optional isError).

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const jsonResult = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const jsonError = (message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true
});

// ── Local tool descriptors (single source of truth) ──────────────────────
// Each local tool is defined ONCE here. Both the MCP registration
// (`createServer`) and the direct test entry point (`handleToolCall`) run tools
// through `invoke`, which validates args with the SAME zod schema — so tests
// exercise the exact validated path production does, not an unchecked copy.

interface LocalTool {
  name: ToolName;
  description: string;
  /** Zod raw shape advertised to MCP and used to validate args. */
  schema: z.ZodRawShape;
  /** Validate `rawArgs`, then run — returns an MCP-shaped result. */
  invoke: (rawArgs: unknown) => ToolResult;
}

function defineLocalTool<S extends z.ZodRawShape>(spec: {
  name: ToolName;
  description: string;
  schema: S;
  run: (args: z.infer<z.ZodObject<S>>) => ToolResult;
}): LocalTool {
  const validator = z.object(spec.schema);
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    invoke: (rawArgs: unknown) => {
      const parsed = validator.safeParse(rawArgs);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return jsonError(`Invalid arguments: ${detail}`);
      }
      try {
        return spec.run(parsed.data);
      } catch (e) {
        return jsonError(String(e));
      }
    }
  };
}

const LOCAL_TOOLS: LocalTool[] = [
  defineLocalTool({
    name: "resolve_dependencies",
    description:
      "Given one or more companion spec namespace aliases, returns the full " +
      "resolved dependency list that MUST go in the YAML `namespaces:` section. " +
      "Always call this before generating the namespaces block.",
    schema: { aliases: z.array(z.string()).describe('Companion spec aliases to resolve (e.g. ["machineTool", "robotics"])') },
    run: ({ aliases }) => jsonResult(resolveDependencies(aliases))
  }),
  defineLocalTool({
    name: "list_namespaces",
    description:
      "List all well-known OPC UA companion spec namespace aliases with their " +
      "full names, URIs, and dependencies. Use this to discover what namespaces are available.",
    schema: {},
    run: () => jsonResult(listNamespaces().map((s) => ({ alias: s.alias, name: s.name, uri: s.uri, dependencies: s.deps })))
  }),
  defineLocalTool({
    name: "list_types",
    description:
      "List ALL ObjectTypes, VariableTypes, and InterfaceTypes defined in a " +
      "specific companion spec namespace. " +
      "ALWAYS call this before using any type from a namespace — NEVER guess type names.",
    schema: { alias: z.string().describe('Companion spec alias (e.g. "machinery", "di", "robotics")') },
    run: ({ alias }) => jsonResult(listTypes(alias))
  }),
  defineLocalTool({
    name: "get_type_details",
    description:
      "Get detailed information about a specific type: its components, properties, " +
      "methods, interfaces, and optional members. Use this to understand a type's " +
      "structure before creating instances or subtypes.",
    schema: {
      alias: z.string().describe('Companion spec alias where the type is defined (e.g. "machinery")'),
      browseName: z.string().describe('The type browse name (e.g. "MachineryItemIdentificationType")')
    },
    run: ({ alias, browseName }) => {
      const details = getTypeDetails(alias, browseName);
      return details ? jsonResult(details) : jsonError(`Type "${browseName}" not found in "${alias}"`);
    }
  }),
  defineLocalTool({
    name: "search_types",
    description:
      "Search for types across ALL companion specs by keyword. " +
      "Use this when you don't know which namespace defines a type. " +
      "Returns matching types with their namespace alias.",
    schema: { query: z.string().describe('Search keyword (e.g. "identification", "temperature", "motion")') },
    run: ({ query }) => jsonResult(searchTypes(query))
  }),
  defineLocalTool({
    name: "find_reusable_block",
    description:
      "Find reusable Interfaces / AddIns by capability — pass a member name or keyword " +
      '(e.g. "SerialNumber", "DeviceHealth", "Location") and get the standard blocks that ' +
      "already expose it. PREFER applying/composing an existing block over redefining its " +
      "members inline. Interfaces are applied with `interfaces:`; addins (types with a " +
      "DefaultInstanceBrowseName) are composed with `addIns:`. A single property → use the " +
      "Interface; a whole named sub-object → use the AddIn.",
    schema: { query: z.string().describe('Member name or capability keyword (e.g. "SerialNumber", "health", "calibration")') },
    run: ({ query }) => jsonResult(findReusableBlock(query))
  }),
  defineLocalTool({
    name: "find_engineering_unit",
    description:
      "Find the official UNECE Rec. 20 engineering unit symbol for a given description. " +
      "ALWAYS call this before using any engineering unit — NEVER guess unit symbols.",
    schema: {
      query: z
        .string()
        .describe('Description or common name of the unit (e.g. "revolutions per minute", "celsius", "pressure bar")')
    },
    run: ({ query }) => {
      const result = findEngineeringUnit(query);
      return result ? jsonResult(result) : jsonError(`No unit found for "${query}"`);
    }
  })
];

const LOCAL_TOOLS_BY_NAME = new Map<ToolName, LocalTool>(LOCAL_TOOLS.map((t) => [t.name, t]));

/**
 * Direct tool call handler for testing (bypasses the MCP protocol). Runs the
 * SAME validated `invoke` path the MCP server uses. Cloud tools are not handled
 * here (they require the network) → treated as unknown.
 */
export async function handleToolCall(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = LOCAL_TOOLS_BY_NAME.get(name);
  if (!tool) return jsonError(`Unknown tool: ${name}`);
  return tool.invoke(args);
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

  // ── LOCAL TOOLS — registered from the single-source descriptors ───────
  // Same list `handleToolCall` uses, so protocol and test paths never diverge.

  for (const tool of LOCAL_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args: unknown) =>
      tool.invoke(args)
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLOUD TOOLS — proxy to api.opcua-modeler.sterfive.io (Phase 1b)
  // These require the SaaS API to be running. Set OPCUA_MODELER_API_KEY
  // in env for authenticated access (generate/reverse require a key).
  // ═══════════════════════════════════════════════════════════════════════

  // ── 7. opcua_model_validate ───────────────────────────────────────────

  server.registerTool(
    "opcua_model_validate",
    {
      description:
        "Validate an OPC UA YAML model for correctness. Returns diagnostics " +
        "with severity (error/warning/info), codes, messages, and line numbers. " +
        "Works without an API key (limited to 50 calls/day). " +
        "ALWAYS validate before generating.",
      inputSchema: {
        yaml: z.string().describe("The full YAML model source to validate")
      }
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

  server.registerTool(
    "opcua_model_generate",
    {
      description:
        "Generate OPC UA NodeSet2.xml and Symbols.CSV from a YAML model. " +
        "Requires an API key (set OPCUA_MODELER_API_KEY env var). " +
        "Returns base64-encoded artifacts if the model is valid, " +
        "or diagnostics if validation fails. " +
        "Optionally set include_docs=true to also generate markdown documentation.",
      inputSchema: {
        yaml: z.string().describe("The full YAML model source to generate from"),
        include_docs: z.boolean().optional().describe("Set to true to include markdown documentation (slower)")
      }
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

  server.registerTool(
    "opcua_model_reverse",
    {
      description:
        "Reverse-engineer a NodeSet2.xml file back into the YAML DSL format. " +
        "Requires an API key (set OPCUA_MODELER_API_KEY env var). " +
        "Optionally specify the target namespace URI to extract.",
      inputSchema: {
        xml: z.string().describe("The NodeSet2.xml content to reverse-engineer"),
        namespace_uri: z.string().optional().describe("Target namespace URI to extract (auto-detected if omitted)")
      }
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

  server.registerTool(
    "opcua_model_create",
    {
      description:
        "Generate an OPC UA YAML model from a natural language description " +
        "using AI. Requires an API key (set OPCUA_MODELER_API_KEY env var). " +
        "The AI will auto-detect relevant companion specs, generate a " +
        "validated model with documentation, and auto-correct validation errors.",
      inputSchema: {
        prompt: z.string().describe("Natural language description of the OPC UA model to generate"),
        forceSpecs: z.array(z.string()).optional().describe('Companion spec aliases to force (e.g. ["di", "ia"])')
      }
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
