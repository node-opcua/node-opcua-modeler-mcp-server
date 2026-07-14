---
name: opcua-modeling
description: >
  Design OPC UA information models grounded in real companion specifications
  (DI, Machinery, Robotics, LADS, Scales, …) using the OPC UA Modeler MCP
  server — look up types, their members and valid optionals, resolve
  namespace dependencies, and find engineering units before writing any
  model, instead of guessing from training data.
---

# OPC UA Modeling with the OPC UA Modeler MCP Server

## When to use this skill

Use it whenever a task involves OPC UA information modeling:

- designing a NodeSet2 / information model for a machine or device
- choosing which **companion specification** types to derive from
- checking what components, properties, methods, or **optionals** a type has
- validating namespace dependencies (`di`, `machinery`, `robotics`, …)
- finding the correct UNECE engineering-unit symbol (`°C`, `l/min`, `N·m`)

Never invent OPC UA type names, browse paths, or unit symbols from memory —
companion specs are too niche for that. Query the catalog instead: the
answers come from the official published NodeSet2.xml files.

## Workflow

1. **`list_namespaces`** — see the ~28 available companion specs with
   aliases, URIs, and dependency lists. Pick the spec(s) matching the domain
   (e.g. `scales` for weighing, `lads` for lab devices).
2. **`search_types` / `list_types`** — find candidate types by keyword
   (e.g. "weighing") or enumerate everything a spec defines.
3. **`get_type_details`** — get a type's full structure: components,
   properties, methods, interfaces, `subtypeOf` chain, and
   **`availableOptionals`** — the exhaustive list of valid optional browse
   paths (including nested dotted paths like
   `di:Identification.machinery:InitialOperationDate`).
4. **`resolve_dependencies`** — given the spec aliases you use, get the
   complete transitively-resolved, load-ordered namespace list to declare.
5. **`find_engineering_unit`** — map natural language ("litre per minute")
   to the valid UNECE symbol before writing any EUInformation.

## Rules of thumb

- **Anchor on companion-spec base types.** Subclass the closest existing
  type (e.g. `scales:ScaleDeviceType`, not `ua:BaseObjectType`) so clients
  recognize the model.
- **`optionals:` entries MUST come from `availableOptionals`.** Never guess
  optional paths and never re-declare inherited components — inherited
  members come for free from the supertype.
- **Declare only the namespaces you use**, in the dependency order returned
  by `resolve_dependencies`.
- Types missing from a spec are a signal to compose (add components) rather
  than to invent look-alike type names.

## Model generation and validation (API key)

The discovery tools above are free and offline. Compiling, validating,
generating, and reverse-engineering full models
(`opcua_model_validate`, `opcua_model_generate`, `opcua_model_reverse`,
`opcua_model_create`) are backed by the Sterfive cloud service — get an API
key at <https://opcua-modeler.sterfive.com> and set `OPCUA_MODELER_API_KEY`.
