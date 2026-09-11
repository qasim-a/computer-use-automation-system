import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapabilityStep } from "../packages/contracts/src/index.js";
import { ActionPolicy, PolicyViolationError } from "../packages/policy/src/index.js";

type NavigateStep = Extract<CapabilityStep, { action: "navigate" }>;

const navigate = (url: string, risk?: CapabilityStep["risk"]): NavigateStep => ({
  id: "open_members",
  action: "navigate",
  description: "Open members",
  url,
  timeoutMs: 10_000,
  ...(risk ? { risk } : {})
});

test("allows configured local routes", async () => {
  await ActionPolicy.localDevelopment().authorize(
    navigate("http://127.0.0.1:4173/members"),
    "about:blank",
    "http://127.0.0.1:4173/members"
  );
});

test("blocks undeclared origins and paths", async () => {
  const policy = ActionPolicy.localDevelopment();
  await assert.rejects(
    policy.authorize(navigate("https://example.com/members"), "about:blank", "https://example.com/members"),
    PolicyViolationError
  );
  await assert.rejects(
    policy.authorize(navigate("http://127.0.0.1:4173/admin"), "about:blank", "http://127.0.0.1:4173/admin"),
    /Path is not allowed/
  );
});

test("requires explicit approval for irreversible actions", async () => {
  const step = navigate("http://127.0.0.1:4173/members", "irreversible");
  await assert.rejects(
    ActionPolicy.localDevelopment().authorize(step, "about:blank", step.url),
    /requires irreversible approval/
  );

  let requested = false;
  const policy = new ActionPolicy({
    allowedOriginPatterns: ["^http://127\\.0\\.0\\.1:4173$"],
    allowedPathPatterns: ["^/members$"],
    allowedActions: ["navigate"],
    requireApprovalFor: ["irreversible"]
  }, async () => { requested = true; return true; });
  await policy.authorize(step, "about:blank", step.url);
  assert.equal(requested, true);
});
