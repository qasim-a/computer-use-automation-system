# Computer-Use Automation System

A focused implementation of an LLM-driven UI discovery run that becomes a deterministic, reusable capability.

## Current milestone

The repository currently contains a local legacy-style member-service target used to develop and test the automation engine. It supports a two-step member lookup and savings-balance workflow plus deterministic not-found, permission-denied, and timeout scenarios.

## Run locally

```bash
npm install
npm run dev:target
```

Open `http://127.0.0.1:4173` and search for member `12345` or `67890`.

```bash
npm test
npm run typecheck
```
