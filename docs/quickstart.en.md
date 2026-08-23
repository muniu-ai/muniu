# Quickstart

Install Node.js 22.19.x, npm 11.10.1, and Git, then run:

```bash
npm ci
npm run build
node apps/cli/dist/index.js app-server --transport ws --port 0
```

In another terminal:

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js provider add --preset deepseek --api-key-env OPENAI_API_KEY
node apps/cli/dist/index.js agent run \
  --provider PROVIDER_ID --model MODEL_ID \
  --prompt "Add one focused test to this repository" --cwd .
```

The app-server listens on loopback and writes connection metadata to `~/.muniu/app-server.json`. `agent run` uses the TypeScript SDK to create Thread/Turn/Item facts and binds model, tools, approvals, commands, Gates, and evidence to one chain. It does not discover Claude/Codex CLI by default.

Read the [v0.2.0 migration guide](migration-v0.2.md) before upgrading existing state.
