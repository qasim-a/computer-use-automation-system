# Computer-Use Automation System

A focused implementation of an LLM-driven UI discovery run that becomes a deterministic, reusable capability.

## Current milestone

The repository currently contains a local legacy-style member-service target, capability contracts, a Playwright surface, and deterministic replay. A bounded discovery runner can use a replaceable decision provider to observe and operate the target, record successful actions as an artifact, and replay that artifact with different inputs.

Copy `.env.example` to `.env` and provide an Anthropic API key only when running live discovery. The automated test suite injects a fake client and never contacts Anthropic.

Run `npm run evidence:live` to perform one bounded Claude discovery and a model-free replay. Redacted logs, the generated artifact, token usage, and final screenshots are written under `evidence/live-run/`.

## Run locally

```bash
npm install
npx playwright install chromium
npm run dev:target
```

Open `http://127.0.0.1:4173` and search for member `12345` or `67890`.

```bash
npm test
npm run typecheck
```
