/**
 * ==========================================================================
 * OPC UA Modeler — the opcua_model_validate tool
 *
 * Two ways in, as for generate:
 *  - `yaml`: the model as text. Works on every transport.
 *  - `model_path` (stdio only): the server reads the model, and the local
 *    backend resolves its `imports:` from the model's own folder — beside it
 *    and in `./deps/` — as the VS Code extension and `opcua-modeler generate`
 *    do. Sent as text alone, a model that imports by `uri:` only is resolved
 *    against the folder `serve` was started in, and fails.
 *
 * IMPORTANT: Never use console.log() — stdout is reserved for JSON-RPC.
 * ==========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { cloudFetch, formatCloudError } from "./cloud.js";
import { isLocalBackend } from "./local.js";

export interface ValidateArgs {
  yaml?: string;
  model_path?: string;
}

export interface ValidateToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface ValidateResponse {
  valid: boolean;
  diagnostics: Array<{ severity: string; code: string; message: string; line?: number }>;
}

const refuse = (code: string, message: string): ValidateToolResult => ({
  content: [{ type: "text", text: `${code}: ${message}` }],
  isError: true
});

/** Input fields; model_path is only offered where the server can reach the user's files. */
export function validateInputSchema(fileAccess: boolean): z.ZodRawShape {
  if (!fileAccess) return { yaml: z.string().describe("The full YAML model source to validate") };
  return {
    yaml: z.string().optional().describe("The full YAML model source. Prefer model_path when the model is a file."),
    model_path: z
      .string()
      .optional()
      .describe(
        "Path to the model file. Its imports resolve from its own folder (beside it, then ./deps/), so an " +
          "import that names only a uri: is found there. Use instead of yaml."
      )
  };
}

export async function runValidate(args: ValidateArgs, ctx: { fileAccess: boolean }): Promise<ValidateToolResult> {
  const byPath = args.model_path !== undefined;
  if (byPath && !ctx.fileAccess)
    return refuse("NO_FILE_ACCESS", "model_path is only available when the server runs locally (stdio).");
  if (byPath === (args.yaml !== undefined)) return refuse("INVALID_ARGUMENTS", "Pass exactly one of yaml and model_path.");

  let yaml = args.yaml ?? "";
  let modelFile: string | undefined;
  if (byPath) {
    modelFile = path.resolve(args.model_path!);
    try {
      yaml = await fs.promises.readFile(modelFile, "utf-8");
    } catch {
      return refuse("MODEL_NOT_FOUND", `Cannot read ${modelFile}.`);
    }
  }

  // As for generate: the folder goes to `serve` only. The hosted API would
  // ignore it, and the user's folder layout is none of its business.
  const workingFolder = modelFile && isLocalBackend() ? path.dirname(modelFile) : undefined;
  let result = workingFolder
    ? await cloudFetch<ValidateResponse>(
        "/api/v1/validate",
        JSON.stringify({ yaml, working_folder: workingFolder }),
        "application/json"
      )
    : await cloudFetch<ValidateResponse>("/api/v1/validate", yaml, "text/yaml");

  // a `serve` older than the JSON body: validate as before, and say why
  // imports may not resolve
  let note: string | undefined;
  if (workingFolder && !result.ok && result.error.status === 415) {
    result = await cloudFetch<ValidateResponse>("/api/v1/validate", yaml, "text/yaml");
    note =
      "This `opcua-modeler serve` predates working_folder on /api/v1/validate: imports resolved from the folder it was " +
      "started in, not the model's. Update it to resolve deps/ beside the model.";
  }

  if (!result.ok) return { content: [{ type: "text", text: formatCloudError(result.error) }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(note ? { ...result.data, note } : result.data) }] };
}
