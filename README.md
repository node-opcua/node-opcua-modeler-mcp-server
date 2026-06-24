# node-opcua-modeler-mcp-server

[![npm version](https://img.shields.io/npm/v/node-opcua-modeler-mcp-server.svg)](https://www.npmjs.com/package/node-opcua-modeler-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

An [MCP server](https://modelcontextprotocol.io) that gives AI agents access to the **OPC UA companion specification type system** — 589 types across 22 industrial namespaces, plus 1,533 engineering units.

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
      "args": ["-y", "node-opcua-modeler-mcp-server"]
    }
  }
}
```

### With any MCP client

```bash
npx node-opcua-modeler-mcp-server
```

The server communicates over **stdio** using the [Model Context Protocol](https://modelcontextprotocol.io).

## Tools

### `list_namespaces`

List all 25 OPC UA companion spec namespaces with aliases, URIs, and dependencies.

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

### `find_engineering_unit`

Find the official UNECE Rec. 20 engineering unit symbol. Supports fuzzy matching and natural language aliases.

```
→ find_engineering_unit({ query: "celsius" })
← { "symbol": "°C", "matchType": "alias", "confidence": 1 }

→ find_engineering_unit({ query: "revolutions per minute" })
← { "symbol": "rpm", "matchType": "alias", "confidence": 1 }

→ find_engineering_unit({ query: "bar" })
← { "symbol": "bar", "matchType": "exact", "confidence": 1 }
```

## Coverage

### Companion Specifications (25)

| Alias | Specification | Types |
|-------|--------------|-------|
| `padim` | OPC UA for PA-DIM | 101 |
| `ijtBase` | OPC UA for IJT Base | 65 |
| `machineTool` | OPC UA for Machine Tools | 63 |
| `di` | OPC UA for Devices | 44 |
| `glass` | OPC UA for Glass Manufacturing | 36 |
| `machineVision` | OPC UA for Machine Vision | 36 |
| `adi` | OPC UA for Analyzer Devices | 35 |
| `commercialKitchenEquipment` | OPC UA for Commercial Kitchen Equipment | 35 |
| `robotics` | OPC UA for Robotics | 25 |
| `ia` | OPC UA for Industrial Automation | 20 |
| `amb` | OPC UA for AMB | 18 |
| `autoId` | OPC UA for AutoID | 18 |
| `metalForming` | OPC UA for Metal Forming | 16 |
| `machinery` | OPC UA for Machinery | 15 |
| `gds` | OPC UA GDS | 14 |
| `woodworking` | OPC UA for Woodworking | 13 |
| `cnc` | OPC UA for CNC Systems | 12 |
| | *…and 5 more* | |
| **Total** | **22 namespaces** | **589 types** |

### Engineering Units

1,533 official UNECE Rec. 20 symbols plus 134 natural language aliases (e.g., "celsius" → °C, "revolutions per minute" → rpm).

## How It Works

The server ships with a pre-generated `catalog.json` containing all type information extracted from OPC Foundation's official NodeSet2.xml files via [node-opcua](https://github.com/node-opcua/node-opcua). All queries are answered from this static catalog — **no network required, no API key needed**.

```
┌─────────────────────────────────────────┐
│  node-opcua-modeler-mcp-server          │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ catalog.json (1.7 MB)           │    │
│  │ • 25 companion spec registries  │    │
│  │ • 589 type summaries + details  │    │
│  │ • 1,533 engineering units       │    │
│  └─────────────────────────────────┘    │
│                                         │
│  6 MCP tools → query the catalog        │
│  stdio transport (JSON-RPC)             │
└─────────────────────────────────────────┘
```

## Use Cases

- **AI-assisted OPC UA modeling** — agents can discover types, resolve dependencies, and validate unit symbols before generating YAML/XML models
- **Copilot integration** — add OPC UA awareness to coding assistants
- **Industrial digital twin design** — explore companion spec type hierarchies interactively
- **Learning OPC UA** — ask an AI to explain types and their relationships

## Requirements

- Node.js ≥ 18

## Related

- [node-opcua](https://github.com/node-opcua/node-opcua) — Full OPC UA stack for Node.js
- [OPC UA Modeler](https://opcua-modeler.sterfive.com) — Create, validate, and generate OPC UA information models
- [Model Context Protocol](https://modelcontextprotocol.io) — Open protocol for AI tool integration

## License

MIT © [Sterfive](https://www.sterfive.com)
