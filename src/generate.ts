/**
 * ==========================================================================
 * OPC UA Modeler — generate: NodeId stability and files on disk
 *
 * Work items 8 and 11. Every regeneration must replay the symbols of the
 * previous one, or the NodeIds change and every server and client bound to
 * them breaks. A tool description alone does not make agents do that, so a
 * generate call has to SAY what it is: an update (symbols passed back), a
 * first generation (`mode: "new"`), or a deliberate renumbering. A call that
 * says nothing is refused before it reaches the backend, with the reason.
 *
 * Each call is judged on its own arguments: nothing is remembered between
 * calls, so the rule holds over stdio and hosted HTTP, and across restarts.
 *
 * The file helpers serve the stdio server only, which runs as the user next
 * to their files: the agent passes a path and never carries the NodeSet2.
 *
 * IMPORTANT: Never use console.log() — stdout is reserved for JSON-RPC.
 * ==========================================================================
 */

import fs from "node:fs";
import path from "node:path";

export type SymbolsMode = "new" | "update" | "renumber";

export interface Hint {
  code: string;
  level: "info" | "warning";
  message: string;
}

export interface Diagnostic {
  severity: string;
  code?: string;
  message: string;
  line?: number | null;
}

// ── Symbols input ─────────────────────────────────────────────────────────

/** A previous generate returned the CSV base64-encoded; accept it as is, or as text. */
export function decodeSymbolsArg(value: string): string {
  // every CSV line holds two commas; base64 never holds one
  return value.includes(",") ? value : Buffer.from(value, "base64").toString("utf-8");
}

/** `name,id,nodeClass` lines, as `toCSV` writes them, to a name → id map. */
export function parseSymbols(csv: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of csv.trim().split(/\r?\n/)) {
    const [name, id] = line.split(",");
    if (name && id !== undefined) out.set(name, Number.parseInt(id, 10));
  }
  return out;
}

/**
 * A self-contained `.opcua.yaml` stream. Restated from
 * `@sterfive/opcua-modeler-ex` (self_contained/stream.ts) rather than
 * imported: this package depends on the MCP SDK and zod only.
 */
export function isSelfContainedStream(text: string): boolean {
  return /^kind:\s*(symbols|declarations|model)\s*$/m.test(text);
}

/** The stream carries its own symbol table, which the engine replays. */
export function hasEmbeddedSymbolTable(text: string): boolean {
  return /^kind:\s*symbols\s*$/m.test(text);
}

/**
 * The symbols CSV paired with a model file: `<name>.model.symbols.csv` next
 * to `<name>.model.yaml`. Restated from `pairedSymbolsFile` in
 * `@sterfive/opcua-modeler-ex` (self_contained/pack.ts); a test on each side
 * pins the same names. Reading also accepts the older `<name>.symbols.csv`.
 */
export function pairedSymbolsFile(modelFile: string, forWriting = false): string {
  const parsed = path.parse(modelFile);
  const generateForm = path.join(parsed.dir, `${parsed.name.replace(/\.opcua$/, ".model")}.symbols.csv`);
  if (forWriting) return generateForm;
  const shortForm = path.join(parsed.dir, `${parsed.name.replace(/\.model$/, "").replace(/\.opcua$/, "")}.symbols.csv`);
  return fs.existsSync(generateForm) || !fs.existsSync(shortForm) ? generateForm : shortForm;
}

/** The files `opcua-modeler generate <model>` writes, in `outputDir` or beside the model. */
export function outputFiles(modelFile: string, outputDir?: string): { nodeset: string; markdown: string; symbols: string } {
  const parsed = path.parse(modelFile);
  const dir = outputDir ?? parsed.dir;
  return {
    nodeset: path.join(dir, `${parsed.name}.Nodeset2.xml`),
    markdown: path.join(dir, `${parsed.name}.md`),
    symbols: path.join(dir, path.basename(pairedSymbolsFile(modelFile, true)))
  };
}

// ── The decision ──────────────────────────────────────────────────────────

export type SymbolsSource = "argument" | "paired-file" | "stream" | "none";

export type SymbolsDecision =
  | {
      ok: true;
      /** CSV text to replay, if any. */
      send?: string;
      /** What the new symbols are compared with: what was replayed, or replaced. */
      previous?: string;
      source: SymbolsSource;
    }
  | { ok: false; code: string; message: string };

export interface SymbolsInput {
  mode?: SymbolsMode;
  /** From the `symbols_csv` argument, decoded. */
  symbolsCsv?: string;
  /** The paired CSV found next to a model passed by path. */
  pairedCsv?: { path: string; text: string };
  /** Where the paired CSV would be, for the messages (path mode). */
  expectedPairedPath?: string;
  embeddedTable: boolean;
}

/** Decide what to replay, or refuse a call that does not say what it is. */
export function decideSymbols(input: SymbolsInput): SymbolsDecision {
  const { mode, symbolsCsv, pairedCsv, embeddedTable } = input;
  const previous = symbolsCsv ?? pairedCsv?.text;
  const source: SymbolsSource = symbolsCsv !== undefined ? "argument" : pairedCsv ? "paired-file" : "none";
  const csvName = input.expectedPairedPath ? path.basename(input.expectedPairedPath) : "<name>.model.symbols.csv";

  if (mode === "renumber") {
    return { ok: true, previous, source: embeddedTable ? "stream" : source };
  }

  if (mode === "new") {
    if (symbolsCsv !== undefined) {
      return {
        ok: false,
        code: "MODE_CONFLICT",
        message:
          'mode "new" is for a model generated for the first time, but symbols_csv was passed. Drop mode to replay them, or pass mode "renumber" to allocate new ids on purpose.'
      };
    }
    if (pairedCsv) {
      return {
        ok: false,
        code: "SYMBOLS_FILE_EXISTS",
        message: `${pairedCsv.path} exists: this model was generated before. Drop mode to keep its NodeIds (the file is read automatically), or pass mode "renumber" to allocate new ids on purpose.`
      };
    }
    if (embeddedTable) {
      return {
        ok: false,
        code: "MODE_CONFLICT",
        message:
          'This self-contained stream carries a symbol table: the model was generated before. Drop mode to keep its NodeIds, or pass mode "renumber".'
      };
    }
    return { ok: true, source: "none" };
  }

  if (previous !== undefined) return { ok: true, send: previous, previous, source };
  if (embeddedTable) return { ok: true, source: "stream" };

  if (mode === "update") {
    return {
      ok: false,
      code: "SYMBOLS_REQUIRED",
      message: `mode "update" needs the symbols of the previous generation: pass them as symbols_csv (the content of ${csvName}).`
    };
  }

  return {
    ok: false,
    code: "SYMBOLS_DECISION_REQUIRED",
    message: [
      "NodeIds only stay stable if you pass back the symbols CSV from the previous generation. Retry with one of:",
      `- generated before: symbols_csv (the content of ${csvName});`,
      '- first generation: mode: "new";',
      '- renumbering on purpose: mode: "renumber".'
    ].join("\n")
  };
}

// ── What changed ──────────────────────────────────────────────────────────

const NAMES_SHOWN = 10;

export interface SymbolsReport {
  /** Same name, same id. */
  reused: number;
  /** Not in the previous symbols. */
  new: number;
  /** In the previous symbols, gone from the model: those ids are retired. */
  dropped: number;
  /** Same name, another id: only on a renumbering, or a wrong CSV. */
  renumbered: number;
  /** Share of the previous names the model still has. */
  match: number;
  new_names: string[];
  dropped_names: string[];
}

export function compareSymbols(previousCsv: string, nextCsv: string): SymbolsReport {
  const before = parseSymbols(previousCsv);
  const after = parseSymbols(nextCsv);
  let reused = 0;
  let renumbered = 0;
  const newNames: string[] = [];
  for (const [name, id] of after) {
    const old = before.get(name);
    if (old === undefined) newNames.push(name);
    else if (old === id) reused++;
    else renumbered++;
  }
  const droppedNames = [...before.keys()].filter((name) => !after.has(name));
  return {
    reused,
    new: newNames.length,
    dropped: droppedNames.length,
    renumbered,
    match: before.size === 0 ? 1 : Math.round(((reused + renumbered) / before.size) * 100) / 100,
    new_names: newNames.slice(0, NAMES_SHOWN),
    dropped_names: droppedNames.slice(0, NAMES_SHOWN)
  };
}

// ── Hints and next steps ──────────────────────────────────────────────────

const MAX_HINTS = 5;
/** Below this share of known names, the CSV most likely belongs to another model. */
const LOW_MATCH = 0.5;

export interface FileWritten {
  role: "nodeset" | "symbols" | "documentation";
  path: string;
  bytes: number;
  status: "written" | "unchanged";
}

export interface HintContext {
  valid: boolean;
  mode?: SymbolsMode;
  source: SymbolsSource;
  report?: SymbolsReport;
  diagnostics: Diagnostic[];
  /** Path mode: what was written. Absent in text mode. */
  files?: FileWritten[];
  /** Show PREFER_STREAM (once per session). */
  suggestStream: boolean;
}

const list = (names: string[], total: number) => names.join(", ") + (total > names.length ? `, … (${total} in all)` : "");

/**
 * Hints are generated by code from fixed conditions, with stable codes: they
 * can be tested and never invent advice. Ranked, and few — a long list is
 * skipped like a long tool description.
 */
export function buildHints(ctx: HintContext): { hints: Hint[]; next_steps: string[] } {
  const ranked: Hint[] = [];
  const { report, files } = ctx;
  const symbolsFile = files?.find((f) => f.role === "symbols");

  if (!ctx.valid) {
    const errors = ctx.diagnostics.filter((d) => d.severity === "error").length;
    ranked.push({
      code: "INVALID",
      level: "warning",
      message: `The model has ${errors} error(s): no artefact was ${files ? "written" : "produced"}. Fix them (opcua_model_validate gives line numbers), then generate again.`
    });
    return { hints: ranked, next_steps: ["Fix the errors listed in diagnostics, then call opcua_model_generate again."] };
  }

  if (report && report.renumbered > 0) {
    ranked.push({
      code: "IDS_RENUMBERED",
      level: "warning",
      message:
        ctx.mode === "renumber"
          ? `${report.renumbered} existing node(s) got a new NodeId, as requested: servers and clients bound to the old ids will break.`
          : `${report.renumbered} node(s) changed NodeId although their symbols were passed: the CSV probably belongs to another model.`
    });
  }
  if (report && report.dropped > 0) {
    ranked.push({
      code: "IDS_DROPPED",
      level: "warning",
      message: `${report.dropped} NodeId(s) retired, their nodes are gone from the model: ${list(report.dropped_names, report.dropped)}. Clients bound to them will break.`
    });
  }
  if (report && ctx.mode !== "renumber" && report.match < LOW_MATCH) {
    ranked.push({
      code: "SYMBOLS_LOW_MATCH",
      level: "warning",
      message: `Only ${Math.round(report.match * 100)}% of the names in the symbols passed exist in this model: they probably belong to another model.`
    });
  }

  if (ctx.source === "none" || ctx.mode === "renumber") {
    ranked.push({
      code: "SAVE_SYMBOLS",
      level: "info",
      message: symbolsFile
        ? `Wrote ${symbolsFile.path}: commit it with the model. Later generates read it from there and keep these NodeIds.`
        : "Save symbols_csv (base64-decoded) as <name>.model.symbols.csv next to the model and commit it. Pass it back as symbols_csv on every later generate, or the NodeIds change."
    });
  } else if (report && (report.new > 0 || report.dropped > 0)) {
    ranked.push({
      code: "SYMBOLS_UPDATED",
      level: "info",
      message: symbolsFile
        ? `${symbolsFile.path} updated: ${report.new} new id(s)${report.new ? ` (${list(report.new_names, report.new)})` : ""}.`
        : `The symbols changed: ${report.new} new id(s)${report.new ? ` (${list(report.new_names, report.new)})` : ""}. Write symbols_csv back to the file it came from.`
    });
  }

  if (ctx.source === "stream") {
    ranked.push({
      code: "STREAM_TABLE_NOT_UPDATED",
      level: "info",
      message:
        "This tool does not rewrite the symbol table embedded in the stream. If the model gained nodes, run `opcua-modeler generate <file>` once to record their ids in it."
    });
  }

  const warnings = ctx.diagnostics.filter((d) => d.severity === "warning");
  if (warnings.length > 0) {
    const top = warnings
      .slice(0, 3)
      .map((d) => `${d.code ?? "warning"}${d.line ? ` line ${d.line}` : ""}`)
      .join(", ");
    ranked.push({
      code: "WARNINGS_PRESENT",
      level: "warning",
      message: `${warnings.length} warning(s) (${top}). Fix them before publishing the NodeSet.`
    });
  }

  if (ctx.suggestStream && ctx.source === "argument") {
    ranked.push({
      code: "PREFER_STREAM",
      level: "info",
      message:
        "Passing the model by path (model_path) or as a self-contained .opcua.yaml stream removes the need to carry symbols_csv between calls."
    });
  }

  const next_steps: string[] = [];
  if (files) {
    const written = files.filter((f) => f.status === "written");
    next_steps.push(
      written.length > 0
        ? `Commit ${written.map((f) => path.basename(f.path)).join(", ")} with the model.`
        : "Nothing changed on disk: the generated files were already up to date."
    );
  } else {
    next_steps.push(
      "Save nodeset2_xml (base64-decoded) as <name>.Nodeset2.xml.",
      "Save symbols_csv (base64-decoded) as <name>.model.symbols.csv, replacing the previous one.",
      "Commit both with the model: the CSV is what keeps NodeIds stable."
    );
  }

  return { hints: ranked.slice(0, MAX_HINTS), next_steps };
}

// ── Files ─────────────────────────────────────────────────────────────────

/**
 * Write `content` unless the file already holds exactly it. Unchanged files
 * are not touched, so git, file watchers and the VS Code extension see
 * nothing when a regeneration changes nothing. The write is atomic: a temp
 * file in the same folder, then a rename, so a crash never leaves half a
 * NodeSet.
 */
export async function writeIfChanged(file: string, content: Buffer): Promise<"written" | "unchanged"> {
  try {
    const existing = await fs.promises.readFile(file);
    if (existing.equals(content)) return "unchanged";
  } catch {
    // absent: write it
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temp, content);
    await fs.promises.rename(temp, file);
  } catch (err) {
    await fs.promises.rm(temp, { force: true });
    throw err;
  }
  return "written";
}
