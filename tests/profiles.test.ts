import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compileCapability } from "../packages/profiles/src/index.js";

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
