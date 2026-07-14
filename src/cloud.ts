/**
 * ==========================================================================
 * OPC UA Modeler — Cloud API Client
 *
 * Thin HTTP wrapper for proxying MCP tool calls to the Sterfive SaaS API.
 * ZERO proprietary dependencies — only native fetch.
 *
 * Configuration via environment variables:
 *   OPCUA_MODELER_API_URL  — Base URL (default: https://api.opcua-modeler.sterfive.io)
 *   OPCUA_MODELER_API_KEY  — API key (stfv_...) for authenticated endpoints
 *
 * IMPORTANT: Never use console.log() — stdout is reserved for JSON-RPC.
 * ==========================================================================
 */

const DEFAULT_API_URL = "https://api.opcua-modeler.sterfive.io";
const TIMEOUT_MS = 30_000;

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
 * Make an authenticated request to the Sterfive SaaS API.
 *
 * @param path    - API path (e.g. "/v1/validate")
 * @param body    - Request body (string)
 * @param contentType - Content-Type header (e.g. "text/yaml", "application/xml")
 * @returns Parsed JSON response or structured error
 */
export async function cloudFetch<T = unknown>(path: string, body: string, contentType: string): Promise<CloudResult<T>> {
  const baseUrl = getApiUrl();
  const apiKey = getApiKey();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    Accept: "application/json"
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (response.ok) {
      const data = (await response.json()) as T;
      return { ok: true, data };
    }

    // Handle specific HTTP error codes with actionable messages
    switch (response.status) {
      case 401:
      case 403:
        return {
          ok: false,
          error: {
            error: "Authentication required. Set OPCUA_MODELER_API_KEY in your MCP server config.",
            status: response.status,
            hint: "Get a free API key at https://opcua-modeler.sterfive.com/settings/api-keys"
          }
        };

      case 429: {
        const retryAfter = response.headers.get("Retry-After");
        const upgradeUrl = response.headers.get("X-Upgrade-URL");
        return {
          ok: false,
          error: {
            error: `Rate limit exceeded.${retryAfter ? ` Try again in ${retryAfter}s.` : ""}`,
            status: 429,
            hint: upgradeUrl ? `Upgrade your plan at ${upgradeUrl}` : "Reduce request frequency or upgrade your plan."
          }
        };
      }

      case 422: {
        // Validation error from the API (e.g. malformed YAML)
        let detail = "";
        try {
          const errBody = (await response.json()) as { detail?: string; message?: string };
          detail = errBody.detail || errBody.message || "";
        } catch {
          detail = await response.text();
        }
        return {
          ok: false,
          error: {
            error: `Validation error: ${detail}`,
            status: 422
          }
        };
      }

      default: {
        let text = "";
        try {
          text = await response.text();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          error: {
            error: `API error (HTTP ${response.status}): ${text || response.statusText}`,
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
          hint: "Check https://opcua-modeler.sterfive.com/status for service status."
        }
      };
    }

    // Network errors (DNS, connection refused, etc.)
    const message = e instanceof Error ? e.message : String(e);
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
