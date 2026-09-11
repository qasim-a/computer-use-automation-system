import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const valueType = z.enum(["string", "number", "boolean"]);

export const parameterSchema = z.object({
  name: identifier,
  type: valueType,
  description: z.string().min(1),
  required: z.boolean().default(true),
  sensitive: z.boolean().default(false)
});

export const locatorSchema = z.object({
  strategy: z.enum(["role", "label", "text", "css"]),
  value: z.string().min(1),
  role: z.string().min(1).optional(),
  exact: z.boolean().default(true)
}).superRefine((locator, context) => {
  if (locator.strategy === "role" && !locator.role) {
    context.addIssue({ code: "custom", message: "A role locator requires role" });
  }
});

export const targetSchema = z.object({
  description: z.string().min(1),
  locators: z.array(locatorSchema).min(1),
  requireUnique: z.boolean().default(true)
});

export const checkpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), matches: z.string().min(1) }),
  z.object({ kind: z.literal("visible"), target: targetSchema }),
  z.object({ kind: z.literal("text"), target: targetSchema, matches: z.string().min(1) })
]);

const commonStep = {
  id: identifier,
  description: z.string().min(1),
  risk: z.enum(["read_only", "reversible", "irreversible"]).optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(2).max(5),
    delayMs: z.number().int().nonnegative().max(5_000)
  }).optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  checkpoint: checkpointSchema.optional()
};

export const stepSchema = z.discriminatedUnion("action", [
  z.object({ ...commonStep, action: z.literal("navigate"), url: z.string().min(1) }),
  z.object({ ...commonStep, action: z.literal("click"), target: targetSchema }),
  z.object({ ...commonStep, action: z.literal("fill"), target: targetSchema, value: z.string() }),
  z.object({ ...commonStep, action: z.literal("extract"), target: targetSchema, output: identifier }),
  z.object({ ...commonStep, action: z.literal("wait"), for: checkpointSchema })
]);

export const capabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  capability: z.object({
    name: identifier,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1),
    target: z.object({ surface: z.literal("web"), app: identifier, entrypoint: z.string().url() })
  }),
  contract: z.object({
    inputs: z.array(parameterSchema),
    outputs: z.array(parameterSchema.omit({ required: true, sensitive: true }).extend({
      pattern: z.string().min(1).optional()
    }))
  }),
  steps: z.array(stepSchema).min(1),
  businessOutcomes: z.array(z.object({
    code: identifier,
    message: z.string().min(1),
    checkpoint: checkpointSchema
  })).default([]),
  success: checkpointSchema,
  metadata: z.object({ createdAt: z.string().datetime(), discoveryRunId: z.string().min(1) })
}).superRefine((artifact, context) => {
  const inputNames = artifact.contract.inputs.map((input) => input.name);
  if (new Set(inputNames).size !== inputNames.length) {
    context.addIssue({ code: "custom", path: ["contract", "inputs"], message: "Input names must be unique" });
  }
  const outputNames = new Set(artifact.contract.outputs.map((output) => output.name));
  for (const [index, step] of artifact.steps.entries()) {
    if (step.action === "extract" && !outputNames.has(step.output)) {
      context.addIssue({ code: "custom", path: ["steps", index, "output"], message: "Extracted output must be declared" });
    }
  }
});

const runContextSchema = z.object({
  runId: z.string().min(1),
  capabilityName: identifier,
  capabilityVersion: z.string(),
  durationMs: z.number().nonnegative()
});

export const replayResultSchema = z.discriminatedUnion("status", [
  runContextSchema.extend({ status: z.literal("success"), outputs: z.record(z.string(), z.unknown()) }),
  runContextSchema.extend({
    status: z.literal("business_outcome"),
    outcome: identifier,
    message: z.string().min(1)
  }),
  runContextSchema.extend({
    status: z.literal("failure"),
    error: z.object({
      code: identifier,
      message: z.string().min(1),
      stepId: identifier.optional(),
      expected: z.string().optional(),
      observed: z.string().optional(),
      evidence: z.array(z.string()).default([])
    })
  })
]);

export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
export type CapabilityStep = z.infer<typeof stepSchema>;
export type ControlTarget = z.infer<typeof targetSchema>;
export type ReplayResult = z.infer<typeof replayResultSchema>;
