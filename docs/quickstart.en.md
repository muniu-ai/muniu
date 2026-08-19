# Quickstart

Install Node.js 22.19.x, npm 11.10.1, and Git, then run:

```bash
npm ci
npm run build
npm run dev:api
```

In another terminal:

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js provider add --preset deepseek --api-key-env OPENAI_API_KEY
node apps/cli/dist/index.js agent run \
  --provider PROVIDER_ID --model MODEL_ID \
  --prompt "Add one focused test to this repository" --cwd .
```

The command creates an isolated session and binds model, tools, approvals, commands, Gates, and evidence to one execution record. It does not discover Claude/Codex CLI by default. Local state lives in `~/.muniu`.
