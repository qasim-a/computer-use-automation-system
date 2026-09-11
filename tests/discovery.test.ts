import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import {
  DiscoveryRunner,
  DiscoveryStoppedError,
  ScriptedDecisionProvider,
  targets,
  type DiscoveryAction
} from "../packages/discovery/src/index.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";

let server: Server;
let origin: string;

before(async () => {
  server = await import("../apps/target/src/server.js").then(({ startTargetServer }) => startTargetServer(0));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

const actions: DiscoveryAction[] = [
  { id: "open_members", action: "navigate", description: "Open member search", url: "${target.entrypoint}", timeoutMs: 10_000 },
  { id: "enter_member_id", action: "fill", description: "Enter member number", target: targets.memberNumber, value: "${inputs.member_id}", timeoutMs: 10_000 },
  { id: "search_member", action: "click", description: "Search for member", target: targets.search, timeoutMs: 10_000 },
  { id: "open_savings", action: "click", description: "Open savings account", target: targets.savingsLink, timeoutMs: 10_000 },
  { id: "read_balance", action: "extract", description: "Read balance", target: targets.balance, output: "current_balance", timeoutMs: 10_000 },
  { action: "finish", description: "Savings balance was extracted", success: { kind: "visible", target: targets.savingsTable } }
];

const request = () => ({
  goal: "Look up member 12345 and return their current savings balance",
  capability: {
    name: "read_savings_balance" as const,
    version: "1.0.0",
    description: "Find a member and return the current savings balance",
    target: { surface: "web" as const, app: "northstar_core" as const, entrypoint: `${origin}/members` }
  },
  contract: {
    inputs: [{ name: "member_id" as const, type: "string" as const, description: "Member number", required: true, sensitive: true }],
    outputs: [{
      name: "current_balance" as const,
      type: "string" as const,
      description: "Displayed savings balance",
      pattern: "^\\$[0-9,]+\\.[0-9]{2}$"
    }]
  },
  inputs: { member_id: "12345" }
});

test("records a discovery run and replays its artifact in a fresh session", async () => {
  const discoverySurface = await PlaywrightWebSurface.launch();
  let discovered;
  try {
    discovered = await new DiscoveryRunner(discoverySurface, new ScriptedDecisionProvider(actions)).run(request());
    assert.deepEqual(discovered.outputs, { current_balance: "$4,281.36" });
    assert.equal(discovered.artifact.steps.length, 5);
    assert.equal(discovered.artifact.metadata.discoveryRunId, discovered.runId);
  } finally {
    await discoverySurface.close();
  }

  const replaySurface = await PlaywrightWebSurface.launch();
  try {
    const replay = await new ReplayEngine(replaySurface).run(discovered.artifact, { member_id: "67890" });
    assert.equal(replay.status, "success");
    if (replay.status === "success") assert.deepEqual(replay.outputs, { current_balance: "$912.04" });
  } finally {
    await replaySurface.close();
  }
});

test("stops a discovery loop at its configured step limit", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    await assert.rejects(
      new DiscoveryRunner(surface, new ScriptedDecisionProvider(actions)).run({ ...request(), maxSteps: 2 }),
      (error) => error instanceof DiscoveryStoppedError && error.turns.length === 2
    );
  } finally {
    await surface.close();
  }
});

test("continues after rejecting an invalid completion claim", async () => {
  const surface = await PlaywrightWebSurface.launch();
  const actionsWithBadFinish = [
    ...actions.slice(0, -1),
    {
      action: "finish" as const,
      description: "Incorrectly claim completion",
      success: { kind: "text" as const, target: targets.balance, matches: "not-the-balance" }
    },
    actions.at(-1)!
  ];
  try {
    const result = await new DiscoveryRunner(surface, new ScriptedDecisionProvider(actionsWithBadFinish)).run({ ...request(), maxSteps: 8 });
    assert.match(result.turns[5]?.error ?? "", /Completion rejected/);
    assert.equal(result.artifact.success.kind, "visible");
  } finally {
    await surface.close();
  }
});

test("rejects literal runtime inputs before recording them", async () => {
  const surface = await PlaywrightWebSurface.launch();
  const literalFill = { ...actions[1]!, value: "12345" } as DiscoveryAction;
  const actionsWithCorrection = [actions[0]!, literalFill, ...actions.slice(1)];
  try {
    const result = await new DiscoveryRunner(surface, new ScriptedDecisionProvider(actionsWithCorrection)).run({ ...request(), maxSteps: 8 });
    assert.match(result.turns[1]?.error ?? "", /must be recorded as/);
    assert.doesNotMatch(JSON.stringify(result.artifact), /12345/);
  } finally {
    await surface.close();
  }
});
