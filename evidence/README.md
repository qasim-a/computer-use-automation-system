# Evidence

`live-run/` contains a genuine Claude Sonnet 5 discovery followed by deterministic replay in a fresh browser session.

- `artifact.json` is the capability produced by the discovery runner.
- `discovery.jsonl` records each observed URL and model-selected action with runtime member IDs redacted.
- `replay.json` is the structured model-free replay result using a different input.
- `usage.json` records the model and token totals for the discovery run.
- The two PNG files show the final discovery and replay UI states.

All member records are synthetic. Recreate this evidence with `npm run evidence:live`; routine tests use an injected fake Anthropic client and make no paid requests.

`exceptional-run/` demonstrates deterministic replay returning `member_not_found` as a declared business outcome, including its redacted event log and final UI screenshot. Recreate it with `npm run demo:exceptional` without an API key.
