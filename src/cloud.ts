/**
 * ==========================================================================
 * OPC UA Modeler — API Client
 *
 * Thin HTTP wrapper for proxying MCP tool calls to a backend that speaks the
 * /api/v1 contract: either the Sterfive SaaS, or a licensed
 * `opcua-modeler serve` running on this machine.
 *
 * ZERO proprietary dependencies — native fetch for the cloud, node:http for
 * the local pipe.
 *
 * Configuration via environment variables:
 *   OPCUA_MODELER_BACKEND  — "cloud" (default) or "local"
 *   OPCUA_MODELER_API_URL  — Base URL (default: https://api.opcua-modeler.sterfive.io)
 *   OPCUA_MODELER_API_KEY  — API key (stfv_...) for authenticated endpoints
 *
 * The two backends are NEVER mixed and there is no fallback between them:
 * on-premise is chosen precisely so that models do not leave the network, and
 * quietly retrying against the hosted API when a local daemon is down would
 * be a data-egress bug rather than a convenience.
 *
 * Both transports resolve to a `Response`, so every status-handling branch
 * below is shared. Only the messages differ, because "set your API key" is
 * nonsense advice for a licensed local server.
 *
 * IMPORTANT: Never use console.log() — stdout is reserved for JSON-RPC.
 * ==========================================================================
 */

import { isLocalBackend, localFetch, readLocalEndpoint } from "./local.js";

const DEFAULT_API_URL = "https://api.opcua-modeler.sterfive.io";
const TIMEOUT_MS = 30_000;

/**
 * The local engine runs in-process on the user's machine, where a large model
 * with documentation can legitimately take minutes — there is no gateway
 * timeout to race, and no other tenant to be fair to.
 */
const LOCAL_TIMEOUT_MS = 300_000;

/** Structured error from the cloud API */
export interface CloudError {
  error: string;
  status?: number;
  hint?: string;
}

/** Result of a cloud API call — either success JSON or structured error */
export type CloudResult<T = unknown> = { ok: true; data: T } | { ok: false; error: CloudError };

function getApiUrl(): string {
  return process.env.OPCUA_MODELER_API_URL || DEFAULT_API_URL;
}

function getApiKey(): string | undefined {
  return process.env.OPCUA_MODELER_API_KEY;
}

/**
 * Extract a human-readable detail (and optional hint) from an error response.
 *
 * The SaaS serializes errors as `{ error: string, hint?: string }` (see
 * api-helpers.ts apiError); `detail`/`message` are tolerated for proxies and
 * older servers. The body is read ONCE as text — a failed response.json()
 * consumes the stream and would make a fallback .text() throw.
 */
async function readErrorBody(response: Response): Promise<{ detail: string; hint?: string; code?: string }> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { detail: "" };
  }
  try {
    const body = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown; hint?: unknown; code?: unknown };
    const detail = [body.error, body.detail, body.message].find((v): v is string => typeof v === "string" && v.length > 0);
    return {
      detail: detail ?? text.trim(),
      hint: typeof body.hint === "string" && body.hint ? body.hint : undefined,
      code: typeof body.code === "string" && body.code ? body.code : undefined
    };
  } catch {
    return { detail: text.trim() };
  }
}

/** Direct renewal link for expired keys — surfaced verbatim to agents/CLI. */
const KEY_SETTINGS_URL = "https://opcua-modeler.sterfive.io/app/settings/api";

/**
 * Make an authenticated request to the Sterfive SaaS API.
 *
 * @param path    - API path (e.g. "/v1/validate")
 * @param body    - Request body (string); ignored for GET
 * @param contentType - Content-Type header (e.g. "text/yaml", "application/xml"); ignored for GET
 * @param method  - HTTP method (default "POST")
 * @returns Parsed JSON response or structured error
 */
export async function cloudFetch<T = unknown>(
  path: string,
  body: string,
  contentType: string,
  method: "GET" | "POST" = "POST"
): Promise<CloudResult<T>> {
  const local = isLocalBackend();

  // Resolve the local endpoint BEFORE the try: "no server running" is a
  // configuration answer, not a transport failure, and deserves its own
  // message rather than being folded into the network-error branch.
  let endpoint: ReturnType<typeof readLocalEndpoint> | undefined;
  if (local) {
    endpoint = readLocalEndpoint();
    if (!endpoint.ok) {
      return { ok: false, error: endpoint.error };
    }
  }

  try {
    let response: Response;

    if (local && endpoint?.ok) {
      response = await localFetch(endpoint.endpoint, path, body, contentType, method, LOCAL_TIMEOUT_MS);
    } else {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (method !== "GET") {
        headers["Content-Type"] = contentType;
      }
      const apiKey = getApiKey();
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        response = await fetch(`${getApiUrl()}${path}`, {
          method,
          headers,
          ...(method !== "GET" ? { body } : {}),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    if (response.ok) {
      const data = (await response.json()) as T;
      return { ok: true, data };
    }

    // Handle specific HTTP error codes with actionable messages
    switch (response.status) {
      case 401:
      case 403: {
        // The server says WHY (invalid key, expired trial, …) — surface it.
        const { detail, hint, code } = await readErrorBody(response);

        // A local server authenticates with a token from its own discovery
        // file, so every word of the SaaS signup advice below is wrong here.
        // The realistic cause is a stale file from a server that has since
        // restarted with a fresh token.
        if (local) {
          return {
            ok: false,
            error: {
              error: detail || "The on-premise server rejected this token.",
              status: response.status,
              hint:
                "The token is read from the server's discovery file. If the server was restarted, " +
                "the file now holds a new token — retry. If that fails, restart `opcua-modeler serve`."
            }
          };
        }

        // Expired beta key: the fix is a rotation, not a signup — surface
        // the renewal link verbatim so agents can relay it to the user.
        if (code === "key_expired") {
          const renewalNote =
            `Rotate your key at ${KEY_SETTINGS_URL} ("Rotate & extend" grants a fresh 30-day window), ` +
            "then update OPCUA_MODELER_API_KEY in this MCP server's config.";
          return {
            ok: false,
            error: {
              error: detail || "Your OPC UA Modeler API key has expired.",
              status: response.status,
              hint: hint?.includes(KEY_SETTINGS_URL)
                ? `${hint} — then update OPCUA_MODELER_API_KEY in this MCP server's config.`
                : renewalNote
            }
          };
        }

        const mcpNote =
          "This MCP server reads the key from OPCUA_MODELER_API_KEY in its config. " +
          "Register at https://opcua-modeler.sterfive.io/signup then create an API key " +
          "under Settings > API (free tier: 25 calls/day, 90-day trial).";
        return {
          ok: false,
          error: {
            error: detail || "Authentication required. Set OPCUA_MODELER_API_KEY in your MCP server config.",
            status: response.status,
            hint: hint ? `${hint} — ${mcpNote}` : mcpNote
          }
        };
      }

      case 429: {
        // The server distinguishes burst / daily / discovery limits — surface it.
        const { detail, hint } = await readErrorBody(response);
        const retryAfter = response.headers.get("Retry-After");
        const upgradeUrl = response.headers.get("X-Upgrade-URL");
        return {
          ok: false,
          error: {
            error: `${detail || "Rate limit exceeded."}${retryAfter ? ` Try again in ${retryAfter}s.` : ""}`,
            status: 429,
            hint: hint || (upgradeUrl ? `Upgrade your plan at ${upgradeUrl}` : "Reduce request frequency or upgrade your plan.")
          }
        };
      }

      case 422: {
        // Validation error from the API (e.g. malformed YAML)
        const { detail, hint } = await readErrorBody(response);
        return {
          ok: false,
          error: {
            error: `Validation error: ${detail || response.statusText || "(the server returned no details)"}`,
            status: 422,
            ...(hint ? { hint } : {})
          }
        };
      }

      case 501: {
        // This backend does not implement the endpoint — on-premise omits AI
        // generation. Distinct from a 404: the URL was right, the capability
        // is absent, and the agent should switch backends rather than retry.
        const { detail, hint } = await readErrorBody(response);
        return {
          ok: false,
          error: {
            error: detail || "This backend does not provide that capability.",
            status: 501,
            hint: hint || "Set OPCUA_MODELER_BACKEND=cloud to use the hosted API for this tool."
          }
        };
      }

      default: {
        const { detail } = await readErrorBody(response);
        return {
          ok: false,
          error: {
            error: `API error (HTTP ${response.status}): ${detail || response.statusText || "(the server returned no details)"}`,
            status: response.status
          }
        };
      }
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        ok: false,
        error: {
          error: `Request timed out after ${TIMEOUT_MS / 1000}s. The server may be unavailable.`,
          hint: "Check https://api.opcua-modeler.sterfive.io/api/health for service status."
        }
      };
    }

    const message = e instanceof Error ? e.message : String(e);

    // A dead pipe means the server exited since it published its file — a
    // different situation from a network problem, and a different fix.
    if (local) {
      return {
        ok: false,
        error: {
          error: `Cannot reach the on-premise OPC UA Modeler server: ${message}`,
          hint:
            "The server may have stopped since it published its discovery file. " +
            "Restart it with `opcua-modeler serve`, or set OPCUA_MODELER_BACKEND=cloud."
        }
      };
    }

    // Network errors (DNS, connection refused, etc.)
    return {
      ok: false,
      error: {
        error: `Cannot reach the OPC UA Modeler API: ${message}`,
        hint: "Check your network connection or verify the API URL."
      }
    };
  }
}

/**
 * Format a CloudError into a user-friendly MCP tool error response.
 */
export function formatCloudError(err: CloudError): string {
  const parts = [err.error];
  if (err.hint) {
    parts.push(`Hint: ${err.hint}`);
  }
  return parts.join("\n");
}
