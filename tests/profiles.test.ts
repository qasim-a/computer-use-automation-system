import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compileCapability } from "../packages/profiles/src/index.js";
import { startTargetServer } from "../apps/target/src/server.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { ActionPolicy } from "../packages/policy/src/index.js";

const loadJson = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("compiles a base capability with a tenant entrypoint and locator overlay", async () => {
  const artifact = await loadJson("../capabilities/read_savings_balance.json");
  const profile = await loadJson("../profiles/northstar_core.profile.json");
  const overlay = await loadJson("../profiles/demo_credit_union.overlay.json");
  overlay.entrypoint = "http://localhost:4180/members";
  overlay.locatorOverrides.member_number[0].value = "Customer Number";

  const compiled = compileCapability(artifact, profile, overlay);
  assert.equal(compiled.tenantId, "demo_credit_union");
  assert.equal(compiled.artifact.capability.target.entrypoint, "http://localhost:4180/members");
  assert.equal(compiled.artifact.steps[1]?.action, "fill");
  if (compiled.artifact.steps[1]?.action === "fill") {
    assert.equal(compiled.artifact.steps[1].target.locators[0]?.value, "Customer Number");
  }
  assert.match(compiled.policy.allowedPathPatterns[0] ?? "", /members/);
});

test("rejects incompatible profiles and unknown target overrides", async () => {
  const artifact = await loadJson("../capabilities/read_savings_balance.json");
  const profile = await loadJson("../profiles/northstar_core.profile.json");
  const overlay = await loadJson("../profiles/demo_credit_union.overlay.json");

  assert.throws(() => compileCapability(artifact, { ...profile, app: "other_app" }), /incompatible/);
  overlay.locatorOverrides.unknown_control = [{ strategy: "text", value: "Unknown", exact: true }];
  assert.throws(() => compileCapability(artifact, profile, overlay), /unknown target keys/);
});

test("replays one base artifact against the different tenant UI through overrides", async () => {
  const server = await startTargetServer(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const artifact = await loadJson("../capabilities/read_savings_balance.json");
  const profile = await loadJson("../profiles/northstar_core.profile.json");
  const overlay = await loadJson("../profiles/demo_credit_union.overlay.json");
  profile.defaultEntrypoint = `${origin}/members`;
  overlay.entrypoint = `${origin}/tenant-two/members`;
  const compiled = compileCapability(artifact, profile, overlay);
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface, new ActionPolicy(compiled.policy))
      .run(compiled.artifact, { member_id: "67890" });
    assert.equal(result.status, "success");
    if (result.status === "success") assert.deepEqual(result.outputs, { current_balance: "$912.04" });
    assert.match((await surface.observe()).url, /\/tenant-two\/members\/67890\/savings$/);
  } finally {
    await surface.close();
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});
