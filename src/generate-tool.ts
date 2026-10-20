/**
 * ==========================================================================
 * OPC UA Modeler — the opcua_model_generate tool
 *
 * Two ways in:
 *  - `yaml`: the model as text; the artefacts come back inline (base64), as
 *    they always did. Works on every transport.
 *  - `model_path` (stdio only): the server reads the model and its paired
 *    symbols CSV, and writes the NodeSet2, the CSV and the docs beside it
 *    exactly as `opcua-modeler generate` does. The agent gets paths, counts
 *    and hints — under 1k tokens instead of the whole NodeSet2 in base64.
 *
 * The rules (what to replay, when to refuse, which hints) live in
 * generate.ts; this file does the I/O around them.
 *
 * IMPORTANT: Never use console.log() — stdout is reserved for JSON-RPC.
 * ==========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { cloudFetch, formatCloudError } from "./cloud.js";
import {
  buildHints,
  compareSymbols,
  type Diagnostic,
  decideSymbols,
  decodeSymbolsArg,
  type FileWritten,
  hasEmbeddedSymbolTable,
  isSelfContainedStream,
  outputFiles,
  pairedSymbolsFile,
  type SymbolsMode,
  writeIfChanged
} from "./generate.js";
import { isLocalBackend } from "./local.js";

export interface GenerateArgs {
  yaml?: string;
  model_path?: string;
  symbols_csv?: string;
  mode?: SymbolsMode;
  include_docs?: boolean;
  output_dir?: string;
  include_artifacts?: "inline";
}

/** State that lives as long as one MCP session (one stdio process). */
export interface GenerateSession {
  streamSuggested: boolean;
}

export interface GenerateContext {
  /** True for the stdio server only: it runs as the user, next to their files. */
  fileAccess: boolean;
  session: GenerateSession;
}

type Content =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string; size: number };

export interface GenerateToolResult {
  [key: string]: unknown;
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface GenerateResponse {
  valid: boolean;
  artifacts?: { nodeset2_xml: string; symbols_csv: string; documentation_md?: string };
  diagnostics: Diagnostic[];
}

/**
 * Backends older than work item 8 answer 415 to the JSON body; the header
 * still works for them, up to what a header can carry (nginx refuses a
 * single header over 8 KB by default).
 */
const HEADER_LIMIT = 6_000;

const refuse = (code: string, message: string): GenerateToolResult => ({
  content: [{ type: "text", text: `${code}: ${message}` }],
  isError: true
});

const decode = (b64: string) => Buffer.from(b64, "base64");

const MIME: Record<FileWritten["role"], string> = {
  nodeset: "application/xml",
  symbols: "text/csv",
  documentation: "text/markdown"
};

/** Input fields; the path-based ones are only offered where the server can reach the user's files. */
export function generateInputSchema(fileAccess: boolean): z.ZodRawShape {
  const base = {
    yaml: fileAccess
      ? z.string().optional().describe("The full YAML model source. Prefer model_path when the model is a file.")
      : z.string().describe("The full YAML model source to generate from"),
    symbols_csv: z
      .string()
      .optional()
      .describe(
        "The symbols CSV of the previous generation (the content of <name>.model.symbols.csv, or the base64 symbols_csv a previous call returned). Keeps NodeIds stable."
      ),
    mode: z
      .enum(["new", "update", "renumber"])
      .optional()
      .describe(
        '"new": first generation, no symbols yet. "update": regeneration, symbols required. "renumber": allocate new NodeIds on purpose. Omit when passing symbols.'
      ),
    include_docs: z.boolean().optional().describe("Set to true to include markdown documentation (slower)")
  };
  if (!fileAccess) return base;
  return {
    ...base,
    model_path: z
      .string()
      .optional()
      .describe(
        "Path to the model file. Its paired <name>.model.symbols.csv is read, and the outputs are written beside it as `opcua-modeler generate` writes them. Use instead of yaml."
      ),
    output_dir: z.string().optional().describe("With model_path: write the outputs here instead of beside the model."),
    include_artifacts: z
      .literal("inline")
      .optional()
      .describe("With model_path: also return the artefacts inline (base64). Off by default: they are large.")
  };
}

/** What a successful call returns as structuredContent. */
export const GENERATE_OUTPUT_SCHEMA = {
  valid: z.boolean(),
  mode: z.enum(["new", "update", "renumber"]),
  symbols_source: z.enum(["argument", "paired-file", "stream", "none"]),
  symbols: z
    .object({
      reused: z.number(),
      new: z.number(),
      dropped: z.number(),
      renumbered: z.number(),
      match: z.number(),
      new_names: z.array(z.string()),
      dropped_names: z.array(z.string())
    })
    .nullable(),
  files: z
    .array(
      z.object({
        role: z.enum(["nodeset", "symbols", "documentation"]),
        path: z.string(),
        bytes: z.number(),
        status: z.enum(["written", "unchanged"])
      })
    )
    .optional(),
  artifacts: z.object({ nodeset2_xml: z.string(), symbols_csv: z.string(), documentation_md: z.string().optional() }).optional(),
  diagnostics: z.array(
    z.object({ severity: z.string(), code: z.string().optional(), message: z.string(), line: z.number().nullable().optional() })
  ),
  hints: z.array(z.object({ code: z.string(), level: z.enum(["info", "warning"]), message: z.string() })),
  next_steps: z.array(z.string())
};

async function callBackend(apiPath: string, yaml: string, send: string | undefined, workingFolder: string | undefined) {
  const body = JSON.stringify({
    yaml,
    ...(send !== undefined ? { symbols_csv: send } : {}),
    ...(workingFolder ? { working_folder: workingFolder } : {})
  });
  const result = await cloudFetch<GenerateResponse>(apiPath, body, "application/json");
  if (result.ok || result.error.status !== 415) return result;

  // an older backend: YAML body, symbols in the header if they fit
  const header = send !== undefined ? Buffer.from(send, "utf-8").toString("base64") : undefined;
  if (header !== undefined && header.length > HEADER_LIMIT) {
    return {
      ok: false as const,
      error: {
        error: "This backend predates the JSON request body, and these symbols are too large for its X-Symbols-Csv header.",
        hint: "Update `opcua-modeler serve` (or wait for the hosted API) to a version that accepts application/json on /api/v1/generate."
      }
    };
  }
  return cloudFetch<GenerateResponse>(apiPath, yaml, "text/yaml", "POST", header ? { "X-Symbols-Csv": header } : {});
}

export async function runGenerate(args: GenerateArgs, ctx: GenerateContext): Promise<GenerateToolResult> {
  const byPath = args.model_path !== undefined;
  if (byPath && !ctx.fileAccess)
    return refuse("NO_FILE_ACCESS", "model_path is only available when the server runs locally (stdio).");
  if (byPath === (args.yaml !== undefined)) return refuse("INVALID_ARGUMENTS", "Pass exactly one of yaml and model_path.");
  if (!byPath && (args.output_dir !== undefined || args.include_artifacts !== undefined)) {
    return refuse("INVALID_ARGUMENTS", "output_dir and include_artifacts go with model_path.");
  }

  // ── the model, and the symbols beside it ──
  let yaml = args.yaml ?? "";
  let modelFile: string | undefined;
  let outputDir: string | undefined;
  if (byPath) {
    modelFile = path.resolve(args.model_path!);
    outputDir = args.output_dir !== undefined ? path.resolve(args.output_dir) : undefined;
    try {
      yaml = await fs.promises.readFile(modelFile, "utf-8");
    } catch {
      return refuse("MODEL_NOT_FOUND", `Cannot read ${modelFile}.`);
    }
  }
  const stream = isSelfContainedStream(yaml);
  const outputs = modelFile ? outputFiles(modelFile, outputDir) : undefined;

  let pairedCsv: { path: string; text: string } | undefined;
  if (modelFile && outputs && !stream) {
    // a stream carries its own table; the engine ignores a sidecar CSV for it
    for (const candidate of [pairedSymbolsFile(modelFile), outputs.symbols]) {
      if (fs.existsSync(candidate)) {
        pairedCsv = { path: candidate, text: await fs.promises.readFile(candidate, "utf-8") };
        break;
      }
    }
  }

  const decision = decideSymbols({
    mode: args.mode,
    symbolsCsv: args.symbols_csv !== undefined ? decodeSymbolsArg(args.symbols_csv) : undefined,
    pairedCsv,
    expectedPairedPath: outputs?.symbols,
    embeddedTable: hasEmbeddedSymbolTable(yaml)
  });
  if (!decision.ok) return refuse(decision.code, decision.message);

  // ── the backend ──
  // working_folder lets `serve` resolve deps/ from the model's folder. Never
  // sent to the hosted API: it would ignore it, and the user's folder layout
  // is none of its business.
  const workingFolder = modelFile && isLocalBackend() ? path.dirname(modelFile) : undefined;
  const apiPath = args.include_docs ? "/api/v1/generate?include=docs" : "/api/v1/generate";
  const result = await callBackend(apiPath, yaml, decision.send, workingFolder);
  if (!result.ok) return { content: [{ type: "text", text: formatCloudError(result.error) }], isError: true };
  const { valid, artifacts, diagnostics } = result.data;

  const report =
    decision.previous !== undefined && artifacts
      ? compareSymbols(decision.previous, decode(artifacts.symbols_csv).toString("utf-8"))
      : undefined;

  // ── files: all or nothing, like the CLI — a failed build writes nothing ──
  let files: FileWritten[] | undefined;
  if (outputs) {
    files = [];
    if (valid && artifacts) {
      const planned: [FileWritten["role"], string, string | undefined][] = [
        ["nodeset", outputs.nodeset, artifacts.nodeset2_xml],
        ["documentation", outputs.markdown, artifacts.documentation_md],
        ["symbols", outputs.symbols, stream ? undefined : artifacts.symbols_csv]
      ];
      for (const [role, file, b64] of planned) {
        if (b64 === undefined) continue;
        const content = decode(b64);
        files.push({ role, path: file, bytes: content.length, status: await writeIfChanged(file, content) });
      }
    }
  }

  const { hints, next_steps } = buildHints({
    valid,
    mode: args.mode,
    source: decision.source,
    report,
    diagnostics,
    files,
    suggestStream: !ctx.session.streamSuggested
  });
  if (hints.some((h) => h.code === "PREFER_STREAM")) ctx.session.streamSuggested = true;

  const structured: Record<string, unknown> = {
    valid,
    mode: args.mode ?? (decision.source === "none" ? "new" : "update"),
    symbols_source: decision.source,
    symbols: report ?? null,
    ...(files ? { files } : {}),
    ...(artifacts && (!files || args.include_artifacts === "inline") ? { artifacts } : {}),
    diagnostics,
    hints,
    next_steps
  };

  return {
    // the JSON text block is what clients without structuredContent show the model
    content: [
      { type: "text", text: JSON.stringify(structured) },
      ...(files ?? []).map((f) => ({
        type: "resource_link" as const,
        uri: pathToFileURL(f.path).href,
        name: path.basename(f.path),
        mimeType: MIME[f.role],
        size: f.bytes
      }))
    ],
    structuredContent: structured
  };
}
