# Contributing

Thanks for your interest. This package is the open-source MCP client for the
OPC UA Modeler; the hosted API and the CLI engine live elsewhere, so most
contributions here are about the MCP surface: tool descriptions, error
messages, local/offline behaviour, docs and tests.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin, version 1.1](https://developercertificate.org/)
instead of a contributor licence agreement. By adding a `Signed-off-by`
trailer to your commits you certify that you wrote the change or otherwise
have the right to submit it under the Apache License 2.0 that governs this
repository.

Add the trailer with `git commit -s`; it looks like:

```
Signed-off-by: Your Name <your.email@example.com>
```

Pull requests whose commits are not signed off cannot be merged.

## Ground rules

- Keep the package free of `@sterfive/*` dependencies and of any proprietary
  data: the catalog is generated from public OPC Foundation NodeSets, and the
  validation / generation / AI logic stays on the server side by design.
- Run `npm run build` and `npm test` before opening a PR.
- One topic per PR; explain the *why* in the description.

## Licence

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE). See also [NOTICE](./NOTICE) for trademark
and third-party notices.
