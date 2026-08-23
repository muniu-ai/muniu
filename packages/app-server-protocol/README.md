# `@mn/app-server-protocol`

Private Zod schemas and inferred TypeScript types for Muniu's selected Codex app-server v2 stable subset.

`src/` is the source of truth. `npm run generate:schema -w @mn/app-server-protocol` deterministically writes the JSON Schema bundle and method catalog under `schema/`; `verify:schema` rejects drift. The compatibility baseline is OpenAI Codex commit `99660ab3c7b861c916e467581fa9b8723504d66b`.

The package does not claim complete Codex app-server compatibility and does not expose experimental upstream methods or fields.
