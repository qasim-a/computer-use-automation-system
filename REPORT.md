# Design Report

## 1. Architecture

I built this as a modular monolith because the assignment needs clear seams, not distributed-system machinery. There are two execution paths sharing the same `Surface` abstraction. Discovery observes the page, asks a `DecisionProvider` for one constrained action, checks policy, performs the action, and records it. Replay loads the resulting capability and executes those recorded steps directly. Claude is therefore a discovery dependency, not a production replay dependency.

The concrete surface is Playwright-backed web automation. An observation contains the URL, title, visible text, interactive controls, and explicitly exposed data fields. This is richer than a raw DOM dump and small enough to send on every model turn. The adapter supports navigation, clicking, filling, text extraction, and screenshots; discovery and replay do not import Playwright themselves.

Claude Sonnet 5 is connected through a replaceable provider. It must choose a single action through an Anthropic tool schema, and the returned value is validated again locally with Zod. Discovery has a fixed step limit, rejects duplicate step IDs and literal sensitive inputs, and verifies Claude's completion claim before emitting an artifact. A scripted provider follows the same interface so reviewers can exercise the whole recording pipeline without credentials or API spend.

I chose a local member-service app instead of a public demo site. That makes the submission repeatable and lets me model the runtime states that matter here without depending on another site's availability or terms. The app is intentionally plain and somewhat legacy-like, but it remains small enough that the automation system—not the demo application—is the focus.

## 2. Artifact schema

The artifact is versioned JSON validated at load time. Its top-level contract identifies the capability and target, declares typed inputs and outputs, stores the ordered steps, defines known business outcomes, and ends with an explicit success checkpoint. Metadata links it back to the discovery run without embedding the raw model transcript.

Each step describes one action and its intent, enforced timeout, optional retry budget, risk classification, and checkpoint. Targets carry an ordered list of locator candidates plus a uniqueness requirement. Inputs are referenced as `${inputs.member_id}` rather than captured values, and outputs may declare a semantic pattern; the balance contract, for example, refuses to accept the label “Current Balance” as though it were a dollar amount. Validation also rejects duplicate identifiers, unknown template references, and outputs without exactly one extraction step.

The schema is deliberately data rather than generated code. It can be reviewed, diffed, signed, migrated, or rejected before execution, and the replay engine never evaluates arbitrary source text. Semantic versioning applies to capabilities independently from `schemaVersion`, allowing the transport format and an individual workflow to evolve on different schedules.

The live comparison exposed an important boundary. Claude discovered five correct, parameterized steps and a robust data-field selector, but its successful trace contained no knowledge of not-found or transient states. The engineered artifact adds that application knowledge through explicit outcomes, retry limits, risk labels, and stronger checkpoints. In a production system, I would make this a compile-and-review stage: model-discovered mechanics plus a versioned vendor/application profile become the candidate capability that a human approves.

## 3. Determinism & error handling

Replay validates the artifact and invocation before touching the UI. It then executes steps in order, substitutes only declared templates, checks policy before every action, resolves visible locators in their recorded order within the step's timeout, and fails on ambiguous matches. There is no model call, semantic search, or open-ended recovery in this path. Checkpoints confirm that navigation or clicks reached the expected state, while output completeness, types, and patterns confirm that extraction returned the intended value.

The result contract separates `success`, `business_outcome`, and `failure`. A missing member is detected through a declared checkpoint and returned as `business_outcome/member_not_found`; it short-circuits retries because repeating a legitimate result cannot help. A transient host error is recoverable because the search step has a fixed two-attempt budget. The retry repeats the same recorded action after a fixed delay—it does not ask Claude to improvise.

Anything not declared as an outcome or recovered inside its budget becomes a hard failure. Stable codes distinguish locator, checkpoint, timeout, output, policy, and other action failures; the result also includes the failing step and expected/observed details when available. The structured event stream records every attempt, and a file-backed observer captures a failure screenshot. The comparison matrix replays both artifacts against two valid members, not-found, and a transient host error; this makes the difference between discovered mechanics and production policy concrete rather than theoretical.

## 4. Heterogeneity & multi-tenant

The main portability seam is `Surface`. The artifact speaks in actions, targets, checkpoints, and outputs; the adapter decides how those concepts map to a browser. A legacy-web adapter could add frame paths, table-relative anchors, or image regions. A desktop adapter could resolve the same target descriptions through an accessibility tree or OS automation. The current schema fixes `surface` to `web`, so adding desktop support would require a versioned discriminated target union; I left that migration explicit instead of pretending desktop already works.

For multi-tenant reuse, I would identify a base capability by vendor product and major UI version, then apply reviewed tenant overlays for entrypoints, branding-specific text, and locator substitutions. Runtime data stays in invocation parameters, not overlays. A tenant first tries the compatible base artifact; repeated checkpoint or locator failures lower its health score and route it for review rather than silently triggering model recovery.

The same mechanism handles controlled drift. Replay evidence can distinguish a business error from a selector/checkpoint failure, while aggregate replay results reveal whether a failure is isolated or shared across a vendor version. This supports reuse across institutions without forcing either one brittle global artifact or a full re-recording for every tenant.

## 5. Escalation & handoff

Replay can attach a `HandoffController` to an exhausted hard failure. The controller records the run, capability version, step, classified failure, attempt count, current observation, and optional screenshot, then passes the request to an `InterventionRouter`. An identified operator explicitly takes control, moving ownership from `handoff_requested` to `human`; until that happens, automation is paused on the same in-memory surface and browser context. Unclaimed requests time out, and callers can cancel a pending or active handoff, so replay cannot wait forever.

The operator acts through an `OperatorSession` backed by that same surface. Navigation, clicks, and fills are recorded with timestamps and operator identity, while filled values are represented as redacted descriptions. When the operator signals resume, ownership passes through `automation_resuming` and back to `automation`. Replay then gets one bounded retry of the blocked step, which covers cases such as dismissing an unfamiliar dialog or repairing session state without turning handoff into an unbounded recovery loop.

The tests exercise both halves of this contract. A real Chromium test proves that the operator reaches and changes the exact page automation paused. A replay integration test injects a blocking condition, waits for human repair, resumes, and completes the previously blocked step. I intentionally did not build a polished co-browsing console; the ownership and session-transfer mechanism is the important seam.

## 6. Safety

An `ActionPolicy` sits in both execution paths. It allowlists action types, origin patterns, and route patterns before the surface receives an action. Steps are treated as read-only, reversible, or irreversible; the irreversible class requires an approval provider and is denied when none is present. Irreversible steps must declare a postcondition and cannot carry automatic retries; after handoff, replay verifies that postcondition instead of repeating a possibly committed action. Policy enforcement is code, not a prompt instruction, and tests confirm that a denied replay performs no navigation.

Sensitive runtime inputs are parameterized before artifact persistence. Observability recursively redacts configured values as well as credential- and PII-shaped keys before writing JSONL. API keys live in `.env`, which is ignored by Git, and mocked Anthropic tests ensure the normal test suite cannot spend money or contact the model. The committed screenshots contain only synthetic member records.

This is still a prototype safety model. Regex-configured routes would become centrally managed policies, approvals would be authenticated and durable, and screenshots would need image-aware redaction before use with real financial data. I would also sign approved artifacts and bind policy versions to execution records so a reviewer could reconstruct exactly what was permitted at run time.

## 7. Cuts

- I implemented one browser surface and documented the adapter migration instead of claiming legacy desktop support.
- Handoff has a real ownership model and shared session, but no production operator console, authentication, or notification service.
- Application profiles and tenant overlays are designed but not stored in a registry or exercised across multiple branded variants.
- Artifact approval, signing, stability scoring, and automatic schema migrations remain next steps after the core execution contract.

I would build those in roughly that order. The current scope deliberately spends its depth on the load-bearing pieces: a genuine model-driven run, a reviewable artifact, deterministic replay, explicit runtime outcomes, enforceable safety, and a real handoff seam.
