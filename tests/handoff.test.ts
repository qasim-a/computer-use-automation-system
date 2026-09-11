import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { startTargetServer } from "../apps/target/src/server.js";
import { HandoffController, HandoffStateError } from "../packages/handoff/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";
import type { Surface } from "../packages/surface/src/index.js";
import { targets } from "../packages/discovery/src/index.js";
import { ReplayEngine } from "../packages/replay/src/index.js";

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
  const handoff = new HandoffController(surface);
  try {
    await surface.navigate(`${origin}/members`);
    const waiting = handoff.requestIntervention({
      capabilityName: "read_savings_balance",
      goal: "Read a member savings balance",
      stepId: "search_member",
      reason: "Automation could not safely identify the next control"
    });
    await waitFor(() => handoff.ownership() === "handoff_requested");
    assert.equal(handoff.currentRequest()?.observation.url, `${origin}/members`);

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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for handoff state");
}
