import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { startTargetServer } from "../apps/target/src/server.js";
import {
  HandoffCancelledError,
  HandoffController,
  HandoffStateError,
  HandoffTimeoutError,
  type InterventionRequest
} from "../packages/handoff/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";
import type { Surface } from "../packages/surface/src/index.js";
import { targets } from "../packages/discovery/src/index.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { ActionPolicy } from "../packages/policy/src/index.js";

let server: Server;
let origin: string;

before(async () => {
  server = await startTargetServer(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test("human takes over and returns the same live browser session", async () => {
  const surface = await PlaywrightWebSurface.launch();
  let routed: InterventionRequest | undefined;
  const handoff = new HandoffController(surface, {
    router: { async route(request) { routed = request; } }
  });
  try {
    await surface.navigate(`${origin}/members`);
    const waiting = handoff.requestIntervention({
      runId: "run-1",
      capabilityName: "read_savings_balance",
      capabilityVersion: "1.0.0",
      goal: "Read a member savings balance",
      stepId: "search_member",
      failure: { code: "locator_failed", message: "Could not identify the next control", attempts: 2 }
    });
    await waitFor(() => handoff.ownership() === "handoff_requested");
    assert.equal(handoff.currentRequest()?.observation.url, `${origin}/members`);
    assert.equal(routed?.runId, "run-1");
    assert.equal(routed?.failure.code, "locator_failed");

    const operator = handoff.takeControl("operator@example.test");
    await operator.fill(targets.memberNumber, "12345");
    await operator.click(targets.search);
    await operator.click(targets.savingsLink);
    operator.resume("Member account opened; automation may continue");

    const resolution = await waiting;
    assert.equal(handoff.ownership(), "automation");
    assert.deepEqual(resolution.actions.map((action) => action.action), ["fill", "click", "click", "resume"]);
    assert.equal(await surface.extractText(targets.balance), "$4,281.36");
    assert.match(resolution.actions[0]?.description ?? "", /value redacted/);
  } finally {
    await surface.close();
  }
});

test("handoff can time out or be cancelled without losing ownership state", async () => {
  const surface = await PlaywrightWebSurface.launch();
  const context = {
    runId: "run-2", capabilityName: "read_savings_balance", capabilityVersion: "1.0.0",
    stepId: "search_member", failure: { code: "locator_failed", message: "Missing control", attempts: 1 }
  };
  try {
    const timed = new HandoffController(surface, { timeoutMs: 10 }).requestIntervention(context);
    await assert.rejects(timed, HandoffTimeoutError);

    const handoff = new HandoffController(surface);
    const cancelled = handoff.requestIntervention(context);
    await waitFor(() => handoff.ownership() === "handoff_requested");
    handoff.cancel("Run was cancelled by its caller");
    await assert.rejects(cancelled, HandoffCancelledError);
    assert.equal(handoff.ownership(), "automation");
  } finally {
    await surface.close();
  }
});

test("rejects invalid ownership transitions", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    const handoff = new HandoffController(surface);
    assert.throws(() => handoff.takeControl("operator@example.test"), HandoffStateError);
  } finally {
    await surface.close();
  }
});

test("replay pauses, accepts a human repair, and retries the blocked step", async () => {
  let repaired = false;
  let completed = false;
  const surface: Surface = {
    navigate: async () => {},
    observe: async () => ({
      url: "http://127.0.0.1:4173/members", title: "Member Service", visibleText: "", controls: [], dataFields: []
    }),
    click: async (target) => {
      if (target.description === "Repair control") { repaired = true; return; }
      if (!repaired) throw new Error("Known dialog blocks the search control");
      completed = true;
    },
    fill: async () => {},
    extractText: async () => completed ? "ready" : "blocked",
    isVisible: async () => completed,
    screenshot: async () => {},
    close: async () => {}
  };
  const handoff = new HandoffController(surface);
  const artifact = {
    schemaVersion: "1.0",
    capability: {
      name: "repairable_search", version: "1.0.0", description: "Test repair",
      target: { surface: "web", app: "northstar_core", entrypoint: "http://127.0.0.1:4173/members" }
    },
    contract: { inputs: [], outputs: [] },
    steps: [{
      id: "search_member", action: "click", description: "Search", timeoutMs: 10_000,
      target: { description: "Search control", locators: [{ strategy: "text", value: "Search", exact: true }], requireUnique: true },
      checkpoint: {
        kind: "text",
        target: { description: "Ready state", locators: [{ strategy: "text", value: "ready", exact: true }], requireUnique: true },
        matches: "ready"
      }
    }],
    success: {
      kind: "text",
      target: { description: "Ready state", locators: [{ strategy: "text", value: "ready", exact: true }], requireUnique: true },
      matches: "ready"
    },
    metadata: { createdAt: "2026-09-11T14:00:00.000Z", discoveryRunId: "handoff-test" }
  };

  const replayPromise = new ReplayEngine(surface, undefined, handoff).run(artifact, {});
  await waitFor(() => handoff.ownership() === "handoff_requested");
  const operator = handoff.takeControl("operator@example.test");
  await operator.click({
    description: "Repair control",
    locators: [{ strategy: "text", value: "Dismiss dialog", exact: true }],
    requireUnique: true
  });
  operator.resume("Blocking dialog dismissed");

  const result = await replayPromise;
  assert.equal(result.status, "success");
  assert.equal(completed, true);
});

test("replay verifies rather than repeats an irreversible action after handoff", async () => {
  let actionCount = 0;
  let committed = false;
  const surface: Surface = {
    navigate: async () => {},
    observe: async () => ({
      url: "http://127.0.0.1:4173/members", title: "Member Service", visibleText: "", controls: [], dataFields: []
    }),
    click: async () => { actionCount += 1; committed = true; throw new Error("Response lost after commit"); },
    fill: async () => {}, extractText: async () => "",
    isVisible: async () => committed, screenshot: async () => {}, close: async () => {}
  };
  const checkpoint = {
    kind: "visible" as const,
    target: { description: "Confirmation", locators: [{ strategy: "text" as const, value: "Done", exact: true }], requireUnique: true }
  };
  const artifact = {
    schemaVersion: "1.0",
    capability: {
      name: "submit_once", version: "1.0.0", description: "Submit exactly once",
      target: { surface: "web", app: "northstar_core", entrypoint: "http://127.0.0.1:4173/members" }
    },
    contract: { inputs: [], outputs: [] },
    steps: [{
      id: "submit", action: "click", description: "Submit", risk: "irreversible", timeoutMs: 10_000,
      target: { description: "Submit", locators: [{ strategy: "text", value: "Submit", exact: true }], requireUnique: true },
      checkpoint
    }],
    success: checkpoint,
    metadata: { createdAt: "2026-09-11T14:00:00.000Z", discoveryRunId: "handoff-test" }
  };
  const policy = new ActionPolicy({
    allowedOriginPatterns: ["^http://127\\.0\\.0\\.1:4173$"], allowedPathPatterns: ["^/members$"],
    allowedActions: ["click"], requireApprovalFor: ["irreversible"]
  }, async () => true);
  const handoff = new HandoffController(surface);
  const replayPromise = new ReplayEngine(surface, policy, handoff).run(artifact, {});
  await waitFor(() => handoff.ownership() === "handoff_requested");
  handoff.takeControl("operator@example.test").resume("Confirmed that submission committed");

  assert.equal((await replayPromise).status, "success");
  assert.equal(actionCount, 1);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for handoff state");
}
