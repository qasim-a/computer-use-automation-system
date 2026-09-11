import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { startTargetServer } from "../apps/target/src/server.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";
import type { Surface } from "../packages/surface/src/index.js";

let server: Server;
let origin: string;
let artifact: Record<string, any>;

before(async () => {
  server = await startTargetServer(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
  artifact = JSON.parse(await readFile(new URL("../capabilities/read_savings_balance.json", import.meta.url), "utf8"));
  artifact.capability.target.entrypoint = `${origin}/members`;
});

after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test("replays a saved capability with no model in the loop", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(artifact, { member_id: "12345" });
    assert.equal(result.status, "success");
    if (result.status === "success") assert.deepEqual(result.outputs, { current_balance: "$4,281.36" });
  } finally {
    await surface.close();
  }
});

test("rejects invalid invocation inputs before touching the surface", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(artifact, { member_id: 12345 });
    assert.equal(result.status, "failure");
    if (result.status === "failure") assert.equal(result.error.code, "invalid_inputs");
    assert.equal((await surface.observe()).url, "about:blank");
  } finally {
    await surface.close();
  }
});

test("passes each artifact step timeout to the surface", async () => {
  const timedArtifact = structuredClone(artifact);
  timedArtifact.steps[0].timeoutMs = 37;
  let navigationTimeout: number | undefined;
  let currentUrl = "about:blank";
  const surface: Surface = {
    navigate: async (url, timeoutMs) => { currentUrl = url; navigationTimeout = timeoutMs; },
    observe: async () => ({ url: currentUrl, title: "", visibleText: "", controls: [], dataFields: [] }),
    click: async () => {}, fill: async () => {}, extractText: async () => "$4,281.36",
    isVisible: async () => true, screenshot: async () => {}, close: async () => {}
  };
  const result = await new ReplayEngine(surface).run(timedArtifact, { member_id: "12345" });
  assert.equal(result.status, "success");
  assert.ok(navigationTimeout !== undefined && navigationTimeout > 0 && navigationTimeout <= 37);
});

test("shares one timeout budget between a step action and its checkpoint", async () => {
  const timedArtifact = structuredClone(artifact);
  timedArtifact.contract.outputs = [];
  timedArtifact.steps = [{
    id: "timed_click", action: "click", description: "Timed click", timeoutMs: 200,
    target: { description: "Control", locators: [{ strategy: "text", value: "Control", exact: true }], requireUnique: true },
    checkpoint: {
      kind: "visible",
      target: { description: "Result", locators: [{ strategy: "text", value: "Result", exact: true }], requireUnique: true }
    }
  }];
  timedArtifact.success = timedArtifact.steps[0].checkpoint;
  const checkpointTimeouts: number[] = [];
  const surface: Surface = {
    navigate: async () => {},
    observe: async () => ({ url: `${origin}/members`, title: "", visibleText: "", controls: [], dataFields: [] }),
    click: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
    fill: async () => {}, extractText: async () => "",
    isVisible: async (_target, timeoutMs) => { checkpointTimeouts.push(timeoutMs ?? 0); return true; },
    screenshot: async () => {}, close: async () => {}
  };
  const result = await new ReplayEngine(surface).run(timedArtifact, { member_id: "12345" });
  assert.equal(result.status, "success");
  assert.ok(checkpointTimeouts[0]! > 0 && checkpointTimeouts[0]! < 180);
});

test("fails replay when extracted text violates the output contract", async () => {
  const invalidExtraction = structuredClone(artifact);
  invalidExtraction.steps.at(-1).target.locators = [{ strategy: "text", value: "Current Balance", exact: true }];
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(invalidExtraction, { member_id: "12345" });
    assert.equal(result.status, "failure");
    if (result.status === "failure") {
      assert.equal(result.error.stepId, "read_balance");
      assert.equal(result.error.code, "output_invalid");
      assert.match(result.error.message, /declared pattern/);
      assert.equal(result.error.expected, "^\\$[0-9,]+\\.[0-9]{2}$");
      assert.equal(result.error.observed, "Current Balance");
    }
  } finally {
    await surface.close();
  }
});

test("policy rejection prevents replay from performing the navigation", async () => {
  let navigations = 0;
  const inertSurface: Surface = {
    navigate: async () => { navigations += 1; },
    observe: async () => ({ url: "about:blank", title: "", visibleText: "", controls: [], dataFields: [] }),
    click: async () => {}, fill: async () => {}, extractText: async () => "", isVisible: async () => true,
    screenshot: async () => {}, close: async () => {}
  };
  const externalArtifact = structuredClone(artifact);
  externalArtifact.capability.target.entrypoint = "https://example.com/members";
  const result = await new ReplayEngine(inertSurface).run(externalArtifact, { member_id: "12345" });
  assert.equal(result.status, "failure");
  if (result.status === "failure") {
    assert.equal(result.error.code, "policy_denied");
    assert.match(result.error.message, /Origin is not allowed/);
  }
  assert.equal(navigations, 0);
});

test("classifies unresolved locators separately from other hard failures", async () => {
  const missingTargetArtifact = structuredClone(artifact);
  missingTargetArtifact.steps.at(-1).timeoutMs = 100;
  missingTargetArtifact.steps.at(-1).target.locators = [{ strategy: "css", value: "[data-field=missing]", exact: true }];
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(missingTargetArtifact, { member_id: "12345" });
    assert.equal(result.status, "failure");
    if (result.status === "failure") {
      assert.equal(result.error.code, "locator_failed");
      assert.equal(result.error.expected, "Current balance");
      assert.match(result.error.observed ?? "", /data-field=missing/);
    }
  } finally {
    await surface.close();
  }
});

test("returns member-not-found as a business outcome rather than a crash", async () => {
  const notFoundArtifact = structuredClone(artifact);
  notFoundArtifact.steps.find((step: any) => step.id === "search_member").timeoutMs = 250;
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(notFoundArtifact, { member_id: "00000" });
    assert.equal(result.status, "business_outcome");
    if (result.status === "business_outcome") assert.equal(result.outcome, "member_not_found");
  } finally {
    await surface.close();
  }
});

test("recovers from a declared transient failure with a bounded retry", async () => {
  const transientArtifact = structuredClone(artifact);
  transientArtifact.capability.target.entrypoint = `${origin}/members?scenario=transient`;
  transientArtifact.steps.find((step: any) => step.id === "search_member").timeoutMs = 500;
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(transientArtifact, { member_id: "67890" });
    assert.equal(result.status, "success");
    if (result.status === "success") assert.deepEqual(result.outputs, { current_balance: "$912.04" });
  } finally {
    await surface.close();
  }
});
