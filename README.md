# Computer-Use Automation System

This project gives an AI agent a safe way to operate software that has no API. Claude first works through a goal in a real browser, and the successful run becomes a typed JSON capability. Later invocations replay that capability in a fixed order without asking a model what to do.

The demo uses a deliberately old-fashioned member-service application. The goal is to find a member, open their savings account, and return the displayed balance. The app also exposes controlled not-found, permission, timeout, and transient states so replay can be tested beyond the happy path.

## Setup

You need Node.js 20 or newer. Install the dependencies and Playwright's Chromium build:

```bash
npm install
npx playwright install chromium
```

No API key is required for deterministic replay or the offline discovery demo. For a live discovery run, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`; the default model is `claude-sonnet-5`. The key is loaded only at runtime, and `.env` is ignored by Git.

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Live discovery only | Authenticates Claude API requests |
| `ANTHROPIC_MODEL` | No | Overrides the default `claude-sonnet-5` model |

## Demo

The commands below start and stop the local target automatically. First, run discovery with the offline scripted decision provider:

```bash
npm run demo:discover -- --mode scripted --member-id 12345 --output output/discovered-capability.json
```

Then replay the saved capability with a different input. No model is invoked during this command:

```bash
npm run demo:replay -- --artifact output/discovered-capability.json --member-id 67890
```

Discovery artifacts start as drafts. To exercise the production gate, run three fresh-session replays, attach reviewer approval, and then require that approval during replay:

```bash
npm run demo:qualify -- --artifact output/discovered-capability.json --member-id 67890 --runs 3 --reviewer your_name --output output/approved-capability.json
npm run demo:replay -- --artifact output/approved-capability.json --member-id 67890 --require-approval true
```

To let Claude discover the same flow for real, change the mode after configuring the API key:

```bash
npm run demo:discover -- --mode live --member-id 12345 --output output/claude-capability.json
```

To demonstrate an expected business outcome rather than a crash:

```bash
npm run demo:exceptional
```

The same replay can be compiled for a tenant through a reviewed application profile and locator overlay:

```bash
npm run demo:replay -- --artifact capabilities/read_savings_balance.json --profile profiles/northstar_core.profile.json --overlay profiles/demo_credit_union.overlay.json --member-id 67890
```

Expected results are `$4,281.36` for member `12345`, `$912.04` for member `67890`, and `member_not_found` for the exceptional command. Each run writes redacted JSONL events and a final screenshot beside its output.

## How it fits together

The code is a modular monolith with boundaries that mirror the production problem. `packages/surface` owns perception and interaction; `packages/discovery` owns the bounded observe-decide-act loop; `packages/contracts` defines the artifact and result schemas; and `packages/replay` executes saved capabilities. Policy, handoff, and observability sit beside those paths so neither Claude nor an artifact can bypass them.

Claude receives compact text, control, and data-field observations and must return one schema-validated tool action. Successful actions are recorded, while raw runtime values are rejected when they should be input placeholders. Replay resolves visible locator candidates in a fixed order within each step's timeout, requires unique matches, checks declared checkpoints and every contracted output, and never calls the model.

The hand-authored capability in `capabilities/read_savings_balance.json` shows how a discovered flow can be enriched with reviewed runtime knowledge. It declares a not-found outcome, a bounded transient retry, explicit risk labels, stable target keys, and additional checkpoints. Application profiles own compatible app versions and policy, while tenant overlays can replace entrypoints and keyed locators without rebuilding the workflow. Exhausted failures can route a bounded intervention request with run and failure context while preserving the live browser session.

## Evidence

`evidence/live-run` contains a genuine six-turn Claude Sonnet 5 discovery, the generated artifact, redacted discovery and replay logs, token usage, screenshots, and a successful model-free replay using a different member. That canonical discovery used 12,353 input tokens and 1,261 output tokens.

`evidence/exceptional-run` contains a deterministic replay that returns `member_not_found`, including its structured event log and final UI state. `evidence/approval` demonstrates three-run qualification and an approval-gated replay. `evidence/artifact-comparison.md` and its JSON source provide the reproducible four-case comparison between the Claude-discovered and engineered artifacts.

Regenerate the live evidence with `npm run evidence:live`, or regenerate the comparison without an API key using `npm run evidence:compare`. All member records are synthetic.

## Verification

```bash
npm test
npm run typecheck
```

The suite currently covers schema validation, model-response parsing, browser interaction, discovery and replay, policy enforcement, output correctness, runtime outcomes, redaction, and same-session handoff. Browser-level tests use the real local target; Anthropic tests inject a fake client and never make paid requests.
