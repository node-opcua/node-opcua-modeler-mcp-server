/**
 * ==========================================================================
 * OPC UA Modeler — On-premise backend transport
 *
 * Talks to `opcua-modeler serve` running as the same OS user, over a named
 * pipe (Windows) or Unix socket. Selected with OPCUA_MODELER_BACKEND=local.
 *
 * Why a pipe rather than a localhost port:
 *
 *   - Both processes are on one machine by definition, so a network socket
 *     buys nothing and adds a surface. There is no address to bind wrongly
 *     and no port to expose beyond the host.
 *   - Access control is the operating system's, not ours: pipe and socket
 *     permissions already scope the endpoint to the user who started it,
 *     with no port-level authorisation layer to design or get wrong.
 *   - No port to allocate, publish, or collide with another service — the
 *     endpoint is named per process and advertised in a discovery file.
 *
 * Why node:http rather than fetch: native fetch cannot address a pipe without
 * a custom dispatcher, and pulling undici into a package whose only runtime
 * deps are the MCP SDK and zod is a poor trade for one option. `socketPath`
 * has been in node:http forever and costs nothing.
 *
 * IMPORTANT: Never use console.log() — stdout is reserved for JSON-RPC.
 * ==========================================================================
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Where `opcua-modeler serve` advertises itself.
 *
 * This is a wire contract between two independently-distributed packages, so
 * the path is restated here rather than imported — this package stays
 * installable on its own, with no build-time coupling to the CLI. Both sides
 * carry a test asserting the same path; change one, change the other.
 *
 * The location follows each platform's convention for per-user runtime state
 * (XDG_RUNTIME_DIR, LOCALAPPDATA), so the endpoint is scoped to the account
 * that started the server.
 */
export function discoveryFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || os.homedir(), "opcua-modeler", "serve.json");
  }
  if (env.XDG_RUNTIME_DIR) {
    return path.join(env.XDG_RUNTIME_DIR, "opcua-modeler", "serve.json");
  }
  return fallbackDiscoveryFilePath();
}

function fallbackDiscoveryFilePath(): string {
  let user = "user";
  try {
    user = os.userInfo().username;
  } catch {
    // Containers without a passwd entry.
  }
  return path.join(os.tmpdir(), `opcua-modeler-${user}`, "serve.json");
}

/**
 * Every place a running server may have published itself, in lookup order.
 *
 * XDG_RUNTIME_DIR is not reliably shared between a terminal and what an editor
 * spawns (WSL: the shell running `serve` has it, the VS Code server may not).
 * A server started WITHOUT it publishes only in the temp fallback, so a client
 * that has it looks there second. The reverse case is covered by the server,
 * which mirrors its file into the fallback.
 */
export function discoveryFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = discoveryFilePath(env);
  if (process.platform === "win32") return [primary];
  const fallback = fallbackDiscoveryFilePath();
  return path.resolve(fallback) === path.resolve(primary) ? [primary] : [primary, fallback];
}

/**
 * True when the temp fallback directory is ours alone.
 *
 * It sits in a shared /tmp: another account could create it first and plant a
 * discovery file pointing at its own socket, then receive the user's models.
 */
function isPrivateDir(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    return (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export interface LocalEndpoint {
  pipe: string;
  token: string;
  pid: number;
  version: string;
  capabilities: string[];
}

/** True when the operator asked for the on-premise backend. */
export function isLocalBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPCUA_MODELER_BACKEND || "").toLowerCase() === "local";
}

const START_HINT =
  "Start it with `opcua-modeler serve` on this machine (it needs a licence " +
  "carrying the 'serve' entitlement), or set OPCUA_MODELER_BACKEND=cloud to " +
  "use the hosted API.";

/**
 * Locate a running server.
 *
 * Deliberately does NOT fall back to the cloud when the file is missing.
 * On-premise is chosen so that models never leave the network; silently
 * shipping a model to the hosted API because a local daemon was down is a
 * data-egress bug, not a convenience.
 */
export function readLocalEndpoint(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; endpoint: LocalEndpoint } | { ok: false; error: { error: string; hint: string } } {
  const candidates = discoveryFileCandidates(env);

  let file = "";
  let raw: string | undefined;
  for (const [index, candidate] of candidates.entries()) {
    // Only the temp fallback can be squatted; the first candidate is either
    // XDG_RUNTIME_DIR or the fallback itself when nothing better exists.
    if (index > 0 && !isPrivateDir(path.dirname(candidate))) continue;
    try {
      raw = fs.readFileSync(candidate, "utf-8");
      file = candidate;
      break;
    } catch {
      // Not published here — try the next place.
    }
  }
  if (raw === undefined) {
    return {
      ok: false,
      error: {
        error: `No on-premise OPC UA Modeler server found (expected ${candidates.join(" or ")}).`,
        hint: `${START_HINT} The server and this MCP server must run as the same user on the same system (under WSL: both inside WSL).`
      }
    };
  }

  let parsed: Partial<LocalEndpoint>;
  try {
    parsed = JSON.parse(raw) as Partial<LocalEndpoint>;
  } catch {
    return {
      ok: false,
      error: { error: `The server discovery file at ${file} is not valid JSON.`, hint: START_HINT }
    };
  }

  if (!parsed.pipe || !parsed.token) {
    return {
      ok: false,
      error: { error: `The server discovery file at ${file} is incomplete.`, hint: START_HINT }
    };
  }

  return {
    ok: true,
    endpoint: {
      pipe: parsed.pipe,
      token: parsed.token,
      pid: parsed.pid ?? 0,
      version: parsed.version ?? "unknown",
      capabilities: parsed.capabilities ?? []
    }
  };
}

/**
 * One request over the pipe, adapted to a `Response`.
 *
 * Returning a real Response means the caller's status handling — 401, 429,
 * 422, the JSON/text error parsing — is the SAME code for both backends. Two
 * copies of that logic is exactly the drift this whole design avoids.
 */
export function localFetch(
  endpoint: LocalEndpoint,
  apiPath: string,
  body: string,
  contentType: string,
  method: "GET" | "POST",
  timeoutMs: number,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      ...extraHeaders,
      Accept: "application/json",
      Authorization: `Bearer ${endpoint.token}`
    };
    if (method !== "GET") {
      headers["Content-Type"] = contentType;
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    const request = http.request({ socketPath: endpoint.pipe, path: apiPath, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve(
          new Response(Buffer.concat(chunks).toString("utf-8"), {
            status: response.statusCode ?? 502,
            headers: { "Content-Type": response.headers["content-type"] ?? "application/json" }
          })
        );
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s.`));
    });
    request.on("error", reject);

    if (method !== "GET") request.write(body);
    request.end();
  });
}
