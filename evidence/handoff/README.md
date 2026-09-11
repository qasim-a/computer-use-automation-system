# Human handoff evidence

Run `npm run demo:handoff -- --operator your_name` from the repository root. The command deliberately places an unexpected host dialog over the search control, exhausts the recorded step's two-attempt budget, and routes a redacted intervention request.

The demo router represents the operator-console seam: the named operator takes ownership of the same Playwright session, dismisses the dialog, records the intervention, and returns control. Replay then retries only the blocked reversible step and completes with no model call. `result.json` records the failure classification, operator, and successful resume; `result-run/events.jsonl` contains the redacted replay events, while the PNGs show the masked handoff and final states.
