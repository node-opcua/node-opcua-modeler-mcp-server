# Hosting the MCP server over HTTP

The server speaks stdio by default (`npx node-opcua-modeler-mcp-server`). To
register it as a **remote connector** (Mistral connectors, claude.ai custom
connectors, any streamable-HTTP MCP client), run it in HTTP mode:

| Route          | Purpose                                               |
| -------------- | ----------------------------------------------------- |
| `POST /mcp`    | MCP JSON-RPC, stateless, JSON responses               |
| `GET /health`  | `{"ok":true}`, never gated                            |
| `GET/DELETE /mcp` | 405 (no sessions in stateless mode)                |

Over HTTP the tools never read or write files: a path would name a file on the
host, not the user's. `generate`, `reverse` and `create` take inline content and
go through the hosted API.

Sterfive already hosts this endpoint at `https://api.opcua-modeler.sterfive.io/mcp`;
self-host only if you need your own API key, auth token or network.

## Environment

| Variable                | Default  | Meaning                                                      |
| ----------------------- | -------- | ------------------------------------------------------------ |
| `PORT`                  | `8807`   | Listen port (bound on `0.0.0.0`)                             |
| `MCP_HTTP_AUTH_TOKEN`   | unset    | If set, `/mcp` requires `Authorization: Bearer <token>` (401 otherwise) |
| `MCP_HTTP_CORS`         | unset    | `1` adds permissive CORS headers (leave off behind Caddy)    |
| `OPCUA_MODELER_API_KEY` | unset    | Sterfive hosted-API key, for the cloud tools                 |
| `OPCUA_MODELER_BACKEND` | `cloud`  | `cloud` or `local`                                           |

## Run it

Standalone:

```bash
npx -p node-opcua-modeler-mcp-server node-opcua-modeler-mcp-http
```

or `node dist/index.js --http` from a checkout.

Docker (from the repository root):

```bash
docker build -t opcua-modeler-mcp . && docker run -p 8807:8807 opcua-modeler-mcp
```

With HTTPS (Caddy + Let's Encrypt; DNS for the hostname must point at the
machine, ports 80/443 open):

```bash
MCP_HOSTNAME=mcp.example.com MCP_HTTP_AUTH_TOKEN=change-me docker compose up -d --build
```

## Verify

```bash
curl -X POST https://<host>/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}'
```

A 200 with `result.capabilities` means the connector will be accepted. Add
`-H "Authorization: Bearer <token>"` when `MCP_HTTP_AUTH_TOKEN` is set.

## Registering on Mistral

In Le Chat, add a custom MCP connector with the server URL
`https://<host>/mcp`. Choose no authentication for an open server, or API
key / bearer token with the value of `MCP_HTTP_AUTH_TOKEN`.
