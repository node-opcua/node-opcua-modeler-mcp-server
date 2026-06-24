/**
 * ==========================================================================
 * OPC UA Modeler MCP Server — Static Catalog Loader
 *
 * Loads the pre-generated catalog.json that contains all public OPC UA
 * companion spec type information. This file is generated at build time
 * by scripts/extract-catalog.ts and committed to git.
 *
 * IMPORTANT: This module has ZERO dependencies on @sterfive/* packages.
 * All data comes from the static JSON catalog.
 * ==========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.resolve(__dirname, "..", "catalog", "catalog.json");

// ── Catalog Types ────────────────────────────────────────────────────────

export interface CompanionSpecEntry {
  alias: string;
  name: string;
  uri: string;
  deps: string[];
  keywords: string[];
  priority: 0 | 1 | 2;
}

export interface TypeSummary {
  browseName: string;
  kind: "ObjectType" | "VariableType" | "ReferenceType" | "DataType";
  namespace: string;
  isAbstract: boolean;
  description?: string;
  subtypeOf?: string;
}

export interface MemberSummary {
  browseName: string;
  nodeClass: string;
  dataType?: string;
  typeDefinition?: string;
  modellingRule?: string;
  description?: string;
}

export interface TypeDetails extends TypeSummary {
  components: MemberSummary[];
  properties: MemberSummary[];
  methods: string[];
  interfaces: string[];
}

export interface EngineeringUnitsData {
  symbols: string[];
  aliases: Record<string, string>;
}

export interface Catalog {
  version: string;
  generatedAt: string;
  registry: CompanionSpecEntry[];
  types: Record<string, TypeSummary[]>;
  typeDetails: Record<string, Record<string, TypeDetails>>;
  engineeringUnits: EngineeringUnitsData;
}

// ── Lazy-loaded singleton ────────────────────────────────────────────────

let _catalog: Catalog | null = null;

function getCatalog(): Catalog {
  if (!_catalog) {
    const raw = fs.readFileSync(CATALOG_PATH, "utf-8");
    _catalog = JSON.parse(raw) as Catalog;
  }
  return _catalog;
}

// ── Public Query API ─────────────────────────────────────────────────────

/** List all companion spec namespaces */
export function listNamespaces(): CompanionSpecEntry[] {
  return getCatalog().registry;
}

/**
 * Resolve the full dependency chain for a set of spec aliases.
 * Returns a topologically sorted list (dependencies before dependents).
 */
export function resolveDependencies(aliases: string[]): string[] {
  const registry = getCatalog().registry;
  const byAlias = new Map(registry.map((s) => [s.alias, s]));
  const resolved = new Set<string>();
  const result: string[] = [];

  function visit(alias: string): void {
    if (resolved.has(alias)) return;
    const spec = byAlias.get(alias);
    if (!spec) return;
    for (const dep of spec.deps) {
      visit(dep);
    }
    resolved.add(alias);
    result.push(alias);
  }

  for (const alias of aliases) {
    visit(alias);
  }

  return result;
}

/** List all types in a companion spec namespace */
export function listTypes(alias: string): TypeSummary[] {
  return getCatalog().types[alias] ?? [];
}

/** Get detailed information about a specific type */
export function getTypeDetails(alias: string, browseName: string): TypeDetails | null {
  const nsDetails = getCatalog().typeDetails[alias];
  if (!nsDetails) return null;
  return nsDetails[browseName] ?? null;
}

/** Search for types across all companion specs by keyword */
export function searchTypes(query: string): (TypeSummary & { alias: string })[] {
  const catalog = getCatalog();
  const results: (TypeSummary & { alias: string })[] = [];
  const q = query.toLowerCase();

  for (const [alias, types] of Object.entries(catalog.types)) {
    for (const t of types) {
      if (
        t.browseName.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
      ) {
        results.push({ ...t, alias });
      }
    }
  }

  return results;
}

// ── Engineering Unit Lookup ──────────────────────────────────────────────

export interface UnitLookupResult {
  symbol: string;
  matchType: "exact" | "case-insensitive" | "alias" | "fuzzy";
  confidence: number;
}

let _unitsLower: Map<string, string> | null = null;

function getUnitsLowerMap(): Map<string, string> {
  if (!_unitsLower) {
    _unitsLower = new Map();
    for (const u of getCatalog().engineeringUnits.symbols) {
      _unitsLower.set(String(u).toLowerCase(), String(u));
    }
  }
  return _unitsLower;
}

/** Find the official engineering unit symbol for a description */
export function findEngineeringUnit(query: string): UnitLookupResult | null {
  if (!query || query.trim().length === 0) return null;

  const catalog = getCatalog();
  const units = catalog.engineeringUnits.symbols.map(String);
  const aliases = catalog.engineeringUnits.aliases;
  const q = query.trim();

  // 1. Exact match
  if (units.includes(q)) {
    return { symbol: q, matchType: "exact", confidence: 1 };
  }

  // 2. Case-insensitive match
  const lowerMap = getUnitsLowerMap();
  const lower = q.toLowerCase();
  const ciMatch = lowerMap.get(lower);
  if (ciMatch) {
    return { symbol: ciMatch, matchType: "case-insensitive", confidence: 0.95 };
  }

  // 3. Alias match (natural language → symbol)
  const aliasMatch = aliases[lower];
  if (aliasMatch) {
    return { symbol: aliasMatch, matchType: "alias", confidence: 1 };
  }

  // 4. Fuzzy: strip quotes, whitespace variants
  const normalized = q.replace(/['"]/g, "").replace(/\s+/g, " ").toLowerCase();
  const aliasNorm = aliases[normalized];
  if (aliasNorm) {
    return { symbol: aliasNorm, matchType: "alias", confidence: 0.9 };
  }

  // 5. Fuzzy: try removing trailing 's' (plurals)
  if (normalized.endsWith("s")) {
    const singular = normalized.slice(0, -1);
    const singularMatch = aliases[singular];
    if (singularMatch) {
      return { symbol: singularMatch, matchType: "fuzzy", confidence: 0.85 };
    }
  }

  return null;
}
