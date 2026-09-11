import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityArtifactSchema, replayResultSchema } from "../packages/contracts/src/index.js";

const artifact = {
  schemaVersion: "1.0",
  capability: {
    name: "read_savings_balance",
    version: "1.0.0",
    description: "Find a member and return the current savings balance",
    target: { surface: "web", app: "northstar_core", entrypoint: "http://127.0.0.1:4173/members" }
  },
  contract: {
    inputs: [{ name: "member_id", type: "string", description: "Member number", required: true, sensitive: true }],
    outputs: [{ name: "current_balance", type: "string", description: "Displayed savings balance", pattern: "^\\$" }]
  },
  steps: [
    { id: "open_members", action: "navigate", description: "Open member search", url: "${target.entrypoint}" },
    {
      id: "enter_member_id", action: "fill", description: "Enter member number", value: "${inputs.member_id}",
      target: { description: "Member Number input", locators: [{ strategy: "label", value: "Member Number", exact: true }], requireUnique: true }
    },
    {
      id: "read_balance", action: "extract", description: "Read current balance", output: "current_balance",
      target: { description: "Current Balance value", locators: [{ strategy: "css", value: "[data-field=current-balance]", exact: true }], requireUnique: true }
    }
  ],
  success: {
    kind: "visible",
    target: { description: "Savings account table", locators: [{ strategy: "role", role: "table", value: "Savings account", exact: true }], requireUnique: true }
  },
  metadata: { createdAt: "2026-09-11T14:00:00.000Z", discoveryRunId: "discovery-example" }
};

test("accepts a reviewable, parameterized capability", () => {
  const parsed = capabilityArtifactSchema.parse(artifact);
  assert.equal(parsed.steps.length, 3);
  assert.equal(parsed.contract.inputs[0]?.sensitive, true);
});

test("rejects extraction into an undeclared output", () => {
  const invalid = structuredClone(artifact);
  invalid.steps[2]!.output = "undeclared_value";
  assert.equal(capabilityArtifactSchema.safeParse(invalid).success, false);
});

test("rejects ambiguous or incomplete artifact contracts", () => {
  const duplicateStep = structuredClone(artifact);
  duplicateStep.steps[1]!.id = duplicateStep.steps[0]!.id;
  assert.equal(capabilityArtifactSchema.safeParse(duplicateStep).success, false);

  const duplicateOutput = structuredClone(artifact);
  duplicateOutput.contract.outputs.push(structuredClone(duplicateOutput.contract.outputs[0]!));
  assert.equal(capabilityArtifactSchema.safeParse(duplicateOutput).success, false);

  const missingProducer = structuredClone(artifact);
  missingProducer.steps = missingProducer.steps.filter((step) => step.action !== "extract");
  assert.equal(capabilityArtifactSchema.safeParse(missingProducer).success, false);

  const unknownTemplate = structuredClone(artifact);
  unknownTemplate.steps[1]!.value = "${inputs.undeclared}";
  assert.equal(capabilityArtifactSchema.safeParse(unknownTemplate).success, false);
});

test("requires complete role locators", () => {
  const invalid: Record<string, any> = structuredClone(artifact);
  delete invalid.success.target.locators[0]!.role;
  assert.equal(capabilityArtifactSchema.safeParse(invalid).success, false);
});

test("requires irreversible actions to have a checkpoint and forbids retries", () => {
  const unsafe: Record<string, any> = structuredClone(artifact);
  unsafe.steps[1]!.risk = "irreversible";
  unsafe.steps[1]!.retry = { maxAttempts: 2, delayMs: 10 };
  assert.equal(capabilityArtifactSchema.safeParse(unsafe).success, false);

  delete unsafe.steps[1]!.retry;
  assert.equal(capabilityArtifactSchema.safeParse(unsafe).success, false);

  unsafe.steps[1]!.checkpoint = unsafe.success;
  assert.equal(capabilityArtifactSchema.safeParse(unsafe).success, true);
});

test("models success, business outcomes, and failures separately", () => {
  const base = { runId: "run-1", capabilityName: "read_savings_balance", capabilityVersion: "1.0.0", durationMs: 42 };
  assert.equal(replayResultSchema.parse({ ...base, status: "success", outputs: { current_balance: "$4,281.36" } }).status, "success");
  assert.equal(replayResultSchema.parse({ ...base, status: "business_outcome", outcome: "member_not_found", message: "No member found" }).status, "business_outcome");
  assert.equal(replayResultSchema.parse({ ...base, status: "failure", error: { code: "checkpoint_failed", message: "Balance missing" } }).status, "failure");
});
