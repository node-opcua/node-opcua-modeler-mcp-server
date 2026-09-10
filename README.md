# node-opcua-modeler-mcp-server

[![npm version](https://img.shields.io/npm/v/node-opcua-modeler-mcp-server.svg)](https://www.npmjs.com/package/node-opcua-modeler-mcp-server)
[![npm downloads/month](https://img.shields.io/npm/dm/node-opcua-modeler-mcp-server.svg)](https://www.npmjs.com/package/node-opcua-modeler-mcp-server)
[![npm downloads total](https://img.shields.io/npm/dt/node-opcua-modeler-mcp-server.svg)](https://www.npmjs.com/package/node-opcua-modeler-mcp-server)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

An [MCP server](https://modelcontextprotocol.io) that gives AI agents access to the **OPC UA companion specification type system** — 749 types across 28 industrial namespaces, plus 1,533 engineering units — and lets agents **validate, generate, reverse-engineer, and create** OPC UA information models.

Built on [node-opcua](https://github.com/node-opcua/node-opcua), the most widely used OPC UA stack for Node.js.

## Why?

When an AI agent needs to build an OPC UA information model, it must know:
- What **companion spec types** exist (DI, Machinery, Robotics, Machine Tools…)
- What **components, properties, and methods** each type has
- What **namespace dependencies** are required
- What **engineering unit symbols** are valid (UNECE Rec. 20)

This MCP server answers all of those questions — **offline, for free, in milliseconds**.

## Quick Start

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opcua-modeler": {
      "command": "npx",
      "args": ["-y", "node-opcua-modeler-mcp-server"],
      "env": {
        "OPCUA_MODELER_API_KEY": "stfv_your_api_key_here"
      }
    }
  }
}
```

> **Note:** The API key is optional for discovery tools (offline) and `opcua_model_validate` (50 anonymous calls/day). It is required for `opcua_model_generate`, `opcua_model_reverse`, and `opcua_model_create`. Register at [opcua-modeler.sterfive.io](https://opcua-modeler.sterfive.io/signup) and create a key under **Settings → API** — the free tier gives 25 calls/day for 90 days; see [pricing](https://opcua-modeler.sterfive.io/pricing) for paid plans.

### With any MCP client

```bash
npx node-opcua-modeler-mcp-server
```

The server communicates over **stdio** using the [Model Context Protocol](https://modelcontextprotocol.io).

### Using a local backend instead of the hosted API

If you run the OPC UA Modeler CLI on the same machine, the model tools can be
served from it instead of the hosted API — your YAML never leaves the host.

Start the server (requires a licence that includes the `serve` entitlement):

```bash
opcua-modeler serve
```

Then set one environment variable in your MCP client config:

```json
{
  "mcpServers": {
    "opcua-modeler": {
      "command": "npx",
      "args": ["-y", "node-opcua-modeler-mcp-server"],
      "env": {
        "OPCUA_MODELER_BACKEND": "local"
      }
    }
  }
}
```

No API key is needed in this mode — the client discovers the local endpoint and
its credentials automatically.

| Variable | Values | Purpose |
|----------|--------|---------|
| `OPCUA_MODELER_BACKEND` | `cloud` (default), `local` | Which backend serves the model tools |
| `OPCUA_MODELER_API_KEY` | `stfv_…` | API key, `cloud` backend only |
| `OPCUA_MODELER_API_URL` | URL | Override the hosted API base URL |

**Notes**

- The two backends are never mixed, and there is no fallback between them. If
  `local` is selected and no server is running, the call fails with instructions
  rather than silently sending your model to the hosted API.
- The seven discovery tools are local to this package and work offline on either
  setting.
- `opcua_model_create` (AI generation) is available on the `cloud` backend only.

## Tools

### `list_namespaces`

List all 28 OPC UA companion spec namespaces with aliases, URIs, and dependencies.

```
→ list_namespaces()
← [
    { "alias": "di", "name": "OPC UA for Devices", "uri": "http://opcfoundation.org/UA/DI/", "dependencies": [] },
    { "alias": "robotics", "name": "OPC UA for Robotics", "uri": "http://opcfoundation.org/UA/Robotics/", "dependencies": ["di", "ia"] },
    ...
  ]
```

### `resolve_dependencies`

Resolve the full dependency chain for companion spec aliases. Returns a topologically sorted list for the YAML `namespaces:` block.

```
→ resolve_dependencies({ aliases: ["machineTool"] })
← ["di", "ia", "machinery", "isa95JobControl", "machineryJobs", "machineTool"]
```

### `list_types`

List all ObjectTypes and VariableTypes defined in a companion spec namespace.

```
→ list_types({ alias: "robotics" })
← [
    { "browseName": "MotionDeviceType", "kind": "ObjectType", "subtypeOf": "di:ComponentType", ... },
    { "browseName": "AxisType", "kind": "ObjectType", "subtypeOf": "di:ComponentType", ... },
    ...
  ]   // 25 types
```

### `get_type_details`

Get the full structure of a type — components, properties, methods, interfaces, including inherited members.

```
→ get_type_details({ alias: "robotics", browseName: "MotionDeviceType" })
← {
    "browseName": "MotionDeviceType",
    "kind": "ObjectType",
    "subtypeOf": "di:ComponentType",
    "interfaces": ["di:IVendorNameplateType", "di:ITagNameplateType"],
    "components": [
      { "browseName": "robotics:Axes", "nodeClass": "Object", "typeDefinition": "FolderType", "modellingRule": "Mandatory" },
      { "browseName": "robotics:PowerTrains", "nodeClass": "Object", "typeDefinition": "FolderType", "modellingRule": "Mandatory" },
      ...
    ],
    "properties": [
      { "browseName": "di:Manufacturer", "dataType": "LocalizedText", "modellingRule": "Mandatory" },
      { "browseName": "robotics:MotionDeviceCategory", "dataType": "MotionDeviceCategoryEnumeration", "modellingRule": "Mandatory" },
      ...
    ]
  }
```

### `search_types`

Search for types across **all** companion specs by keyword.

```
→ search_types({ query: "temperature" })
← [
    { "alias": "glass", "browseName": "MotorTemperatureTooHighEventType", ... },
    { "alias": "padim", "browseName": "TemperatureMeasurementVariableType", ... },
    { "alias": "amb", "browseName": "OverTemperatureConditionClassType", ... }
  ]
```

### `find_reusable_block`

Find reusable Interfaces and AddIns by capability — pass a member name or keyword
and get the standard blocks that already expose it. Prefer composing an existing
block over redefining its members by hand.

```
→ find_reusable_block({ query: "SerialNumber" })
← [
    {
      "browseName": "di:IVendorNameplateType",
      "alias": "di",
      "kind": "interface",
      "matchedMembers": ["di:SerialNumber"],
      "members": ["di:Manufacturer", "di:Model", "di:SerialNumber", ...]
    },
    {
      "browseName": "machinery:MachineIdentificationType",
      "alias": "machinery",
      "kind": "addin",
      "matchedMembers": ["di:SerialNumber"],
      "members": ["machinery:Location", "di:SerialNumber", ...]
    }
  ]
```

`kind` tells you how to apply it: `interface` goes in `interfaces:`, `addin` in
`addIns:`.

### `find_engineering_unit`

Find the official UNECE Rec. 20 engineering unit symbol. Supports fuzzy matching and natural language aliases.

```
→ find_engineering_unit({ query: "celsius" })
← { "symbol": "°C", "matchType": "alias", "confidence": 1 }

→ find_engineering_unit({ query: "revolutions per minute" })
← { "symbol": "r/min", "matchType": "alias", "confidence": 1 }

→ find_engineering_unit({ query: "bar" })
← { "symbol": "bar", "matchType": "exact", "confidence": 1 }
```

### `get_dsl_reference` ☁️

Fetch the YAML DSL grammar reference — the file header, top-level sections, type
and instance syntax, and a list of common mistakes. **No API key required.**

Served from the API rather than bundled into this package, so the reference an
agent reads always matches the validator that will judge its output.

```
→ get_dsl_reference()
← { "version": "1", "reference": "# OPC UA Modeler YAML DSL ..." }
```

### `opcua_model_validate` ☁️

Validate an OPC UA YAML model for correctness. Returns diagnostics with severity, codes, messages, and line numbers. Works without an API key (limited to 50 calls/day per IP).

```
→ opcua_model_validate({ yaml: "namespaces:\n  di:\n..." })
← {
    "valid": true,
    "diagnostics": [
      { "severity": "warning", "code": "W001", "message": "...", "line": 42 }
    ]
  }
```

### `opcua_model_generate` ☁️

Generate OPC UA NodeSet2.xml and Symbols.CSV from a validated YAML model. Returns base64-encoded artifacts. Requires an API key.

```
→ opcua_model_generate({ yaml: "namespaces:\n  di:\n...", include_docs: false })
← {
    "valid": true,
    "artifacts": {
      "nodeset2_xml": "PD94bWwg...",
      "symbols_csv": "bmFtZSxu..."
    },
    "diagnostics": []
  }
```

### `opcua_model_reverse` ☁️

Reverse-engineer a NodeSet2.xml file back into the YAML DSL format. Requires an API key.

```
→ opcua_model_reverse({ xml: "<?xml version=..." })
← {
    "yaml": "namespaces:\n  di:\n...",
    "diagnostics": []
  }
```

### `opcua_model_create` ☁️

Generate an OPC UA YAML model from a natural language description using AI. The AI will auto-detect relevant companion specs, generate a validated model with documentation, and auto-correct validation errors. Requires an API key.

```
→ opcua_model_create({ prompt: "A robotic welding cell with two robot arms, each having 6 axes, temperature monitoring on each motor" })
← {
    "success": true,
    "yaml": "namespaces:\n  di:\n  robotics:\n...",
    "attempts": 2,
    "diagnostics": [],
    "model": "gemini-2.5-pro",
    "tokens": { "input": 4200, "output": 1800 }
  }

→ opcua_model_create({ prompt: "A CNC lathe with spindle speed and temperature", forceSpecs: ["di", "cnc"] })
← {
    "success": true,
    "yaml": "namespaces:\n  di:\n  cnc:\n...",
    "attempts": 1,
    "diagnostics": [],
    "model": "gemini-2.5-pro",
    "tokens": { "input": 3500, "output": 1200 }
  }
```

## Coverage

### Companion Specifications (28)

| Alias | Specification | Types |
|-------|--------------|-------|
| `padim` | OPC UA for PA-DIM | 101 |
| `ijtBase` | OPC UA for IJT Base | 65 |
| `machineTool` | OPC UA for Machine Tools | 63 |
| `scales` | OPC UA for Scales | 58 |
| `lads` | OPC UA for Laboratory Devices | 53 |
| `di` | OPC UA for Devices | 44 |
| `glass` | OPC UA for Glass Manufacturing | 36 |
| `machineVision` | OPC UA for Machine Vision | 36 |
| `adi` | OPC UA for Analyzer Devices | 35 |
| `commercialKitchenEquipment` | OPC UA for Commercial Kitchen Equipment | 35 |
| `i4aas` | OPC UA for I4AAS | 32 |
| `robotics` | OPC UA for Robotics | 25 |
| `ia` | OPC UA for Industrial Automation | 20 |
| `amb` | OPC UA for AMB | 18 |
| `autoId` | OPC UA for AutoID | 18 |
| `iolink` | OPC UA for IO-Link | 16 |
| `metalForming` | OPC UA for Metal Forming | 16 |
| | *…and 10 more* | |
| **Total** | **27 namespaces with types** | **749 types** |

The registry holds **28** specs; `irdi` is a dictionary-entry namespace and
defines no ObjectTypes or VariableTypes. These figures come from
`catalog/catalog.json` and are asserted against it by
`test/catalog-coverage.test.ts`, so they cannot drift silently.

### Engineering Units

1,533 official UNECE Rec. 20 symbols plus 136 natural language aliases (e.g., "celsius" → °C, "revolutions per minute" → r/min). Every alias resolves to a symbol the modeler engine accepts — the lookup never invents one.

## How It Works

The server ships with a pre-generated `catalog.json` containing all type information extracted from OPC Foundation's official NodeSet2.xml files via [node-opcua](https://github.com/node-opcua/node-opcua). All queries are answered from this static catalog — **no network required, no API key needed**.

```
┌──────────────────────────────────────────────────┐
│  node-opcua-modeler-mcp-server                   │
│                                                  │
│  LOCAL TOOLS (offline, free)                      │
│  ┌────────────────────────────────────────┐       │
│  │ catalog.json (1.7 MB)                  │       │
│  │ • 28 companion spec registries         │       │
│  │ • 749 type summaries + details         │       │
│  │ • 1,533 engineering units              │       │
│  └────────────────────────────────────────┘       │
│  7 tools → query the catalog                     │
│                                                  │
│  CLOUD TOOLS (via api.opcua-modeler.sterfive.io) │
│  5 tools → reference / validate / generate /     │
│           reverse / create                       │
│                                                  │
│  stdio transport (JSON-RPC)                      │
└──────────────────────────────────────────────────┘
```

## Use Cases

- **AI-assisted OPC UA modeling** — agents can discover types, resolve dependencies, and validate unit symbols before generating YAML/XML models
- **Copilot integration** — add OPC UA awareness to coding assistants
- **Industrial digital twin design** — explore companion spec type hierarchies interactively
- **Learning OPC UA** — ask an AI to explain types and their relationships

## Requirements

- Node.js ≥ 18

## Related

- [OPC UA Modeler — web app](https://opcua-modeler.sterfive.io) — Create, validate, and generate OPC UA information models in the browser
- [Product page](https://www.sterfive.com/product/opcua-modeler) — OPC UA Modeler overview, features, and licensing
- [Documentation](https://opcua-modeler.doc.sterfive.com) — Guides, YAML DSL reference, and how-tos
- [Specification reference](https://opcua-modeler.doc.sterfive.com/specification/spec.html) — Rendered OPC UA information-model specification
- [node-opcua](https://github.com/node-opcua/node-opcua) — Full OPC UA stack for Node.js
- [Model Context Protocol](https://modelcontextprotocol.io) — Open protocol for AI tool integration

## Licensing

Three layers, stated once:

| What | Licence |
|------|---------|
| **This package** (`node-opcua-modeler-mcp-server`, the MCP client and its catalog) | [Apache License 2.0](./LICENSE) from version 1.5.0 — see [NOTICE](./NOTICE) for trademark and third-party notices. Versions 1.0–1.4.x were published under MIT and remain so. |
| **The hosted OPC UA Modeler API** (`opcua-modeler.sterfive.io/api/v1`) that the cloud backend calls | [Sterfive API Terms of Use](https://opcua-modeler.sterfive.io/terms) — anonymous discovery, free and paid plans. |
| **The OPC UA Modeler CLI and `opcua-modeler serve`** (the local backend) | Sterfive commercial licence — see the [product page](https://www.sterfive.com/product/opcua-modeler). |

"OPC UA Modeler" and "Sterfive" are trademarks of Sterfive SAS; the Apache
licence grants no rights to them. Contributions are accepted under the
[Developer Certificate of Origin](./CONTRIBUTING.md).

© [Sterfive SAS](https://www.sterfive.com)
