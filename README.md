# Computer-Use Automation System

A focused implementation of an LLM-driven UI discovery run that becomes a deterministic, reusable capability.

## Current milestone

The repository currently contains a local legacy-style member-service target, the versioned capability contract, a Playwright-backed surface abstraction, and a deterministic replay engine. The saved example capability performs the balance workflow without a model in the decision loop.

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
