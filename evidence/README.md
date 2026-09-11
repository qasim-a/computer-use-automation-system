# Evidence

`live-run/` contains a genuine Claude Sonnet 5 discovery followed by deterministic replay in a fresh browser session.

- `artifact.json` is the capability produced by the discovery runner.
- `discovery.jsonl` records each observed URL and model-selected action with runtime member IDs redacted.
- `replay.jsonl` is the detailed redacted event log for the model-free replay, while `replay.json` is its structured result using a different input.
- `usage.json` records the model and token totals for the discovery run.
- The two PNG files show the final discovery and replay UI states.

All member records are synthetic. Recreate this evidence with `npm run evidence:live`; routine tests use an injected fake Anthropic client and make no paid requests.

`exceptional-run/` demonstrates deterministic replay returning `member_not_found` as a declared business outcome, including its redacted event log and final UI screenshot. Recreate it with `npm run demo:exceptional` without an API key.

`artifact-comparison.md` and its JSON source compare the engineered and Claude-discovered artifacts structurally and across a four-case replay matrix. Recreate them with `npm run evidence:compare` without an API key.

`approval/` contains a draft qualification promoted after three consistent fresh-session replays, followed by a replay that requires and verifies the saved approval. It uses a demonstration reviewer identity and requires no API key.

`cross-tenant/` replays one unchanged base artifact against two visibly different variants. The second run changes its route family, labels, navigation text, and output selectors through the reviewed tenant overlay; both runs return the same typed result without discovery or model use.
