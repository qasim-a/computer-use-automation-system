# Computer-Use Automation System

A focused implementation of an LLM-driven UI discovery run that becomes a deterministic, reusable capability.

## Current milestone

The repository currently contains a local legacy-style member-service target, capability contracts, a Playwright surface, and deterministic replay. A bounded discovery runner can use a replaceable decision provider to observe and operate the target, record successful actions as an artifact, and replay that artifact with different inputs.

Copy `.env.example` to `.env` and provide an Anthropic API key only when running live discovery. The automated test suite injects a fake client and never contacts Anthropic.

Run `npm run evidence:live` to perform one bounded Claude discovery and a model-free replay. Redacted logs, the generated artifact, token usage, and final screenshots are written under `evidence/live-run/`.

Every discovery and replay action passes through a declarative policy that allowlists action types, origins, and routes. Steps are classified as read-only, reversible, or irreversible; the irreversible class cannot run without an explicit approval provider.

Replay distinguishes successful outputs, declared business outcomes, and hard failures. Individual steps may opt into a small fixed retry budget for known recoverable conditions; retries repeat the same recorded action and never invoke a model.

Hard failures can route into a same-session handoff controller. Automation pauses with contextual state and an optional screenshot, an identified operator controls the existing surface through an audited session, and replay resumes with one bounded retry after control is returned.

Structured observers record run, step, retry, outcome, and failure events. The file observer recursively redacts configured values and sensitive keys before writing JSONL, and captures a screenshot when replay ends in a hard failure.

## Run locally

```bash
npm install
npx playwright install chromium
npm run dev:target
```

Open `http://127.0.0.1:4173` and search for member `12345` or `67890`.

## Reviewer demo

The demo commands start and stop the target app automatically. First, discover a capability without an API key using the deterministic decision fixture:

```bash
npm run demo:discover -- --mode scripted --member-id 12345 --output output/discovered-capability.json
```

Replay that artifact with a different input and no model in the loop:

```bash
npm run demo:replay -- --artifact output/discovered-capability.json --member-id 67890
```

With `ANTHROPIC_API_KEY` configured, replace `--mode scripted` with `--mode live` for genuine Claude discovery. To reproduce the declared not-found business outcome and its redacted evidence:

```bash
npm run demo:exceptional
```

## Verification

```bash
npm test
npm run typecheck
```
