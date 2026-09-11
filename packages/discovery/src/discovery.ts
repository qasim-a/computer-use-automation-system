import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  capabilityArtifactSchema,
  checkpointSchema,
  stepSchema,
  type CapabilityArtifact,
  type CapabilityStep,
  type ControlTarget
} from "../../contracts/src/index.js";
import type { Surface, SurfaceObservation } from "../../surface/src/index.js";
import { ActionPolicy } from "../../policy/src/index.js";
import { NoopRunObserver, type RunObserver } from "../../observability/src/index.js";

type Checkpoint = NonNullable<CapabilityStep["checkpoint"]>;

export type DiscoveryAction =
  | CapabilityStep
  | { action: "finish"; description: string; success: Checkpoint };

export const discoveryActionSchema = z.union([
  stepSchema,
  z.object({ action: z.literal("finish"), description: z.string().min(1), success: checkpointSchema })
]);

export type DiscoveryTurn = {
  step: number;
  observation: SurfaceObservation;
  action: DiscoveryAction;
  error?: string;
};

export type DecisionContext = {
  goal: string;
  step: number;
  observation: SurfaceObservation;
  history: readonly DiscoveryTurn[];
  availableInputs: readonly string[];
  declaredOutputs: readonly string[];
  completedOutputs: readonly string[];
};

export interface DecisionProvider {
  decide(context: DecisionContext): Promise<DiscoveryAction>;
}

export type DiscoveryRequest = {
  goal: string;
  capability: CapabilityArtifact["capability"];
  contract: CapabilityArtifact["contract"];
  inputs: Record<string, unknown>;
  maxSteps?: number;
};

export type DiscoveryResult = {
  runId: string;
  artifact: CapabilityArtifact;
  outputs: Record<string, unknown>;
  turns: DiscoveryTurn[];
};

export class DiscoveryStoppedError extends Error {
  constructor(message: string, readonly turns: readonly DiscoveryTurn[]) {
    super(message);
    this.name = "DiscoveryStoppedError";
  }
}

export class DiscoveryRunner {
  constructor(
    private readonly surface: Surface,
    private readonly decisions: DecisionProvider,
    private readonly policy = ActionPolicy.localDevelopment(),
    private readonly observer: RunObserver = new NoopRunObserver()
  ) {}

  async run(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const runId = randomUUID();
    const maxSteps = request.maxSteps ?? 12;
    const turns: DiscoveryTurn[] = [];
    const recordedSteps: CapabilityStep[] = [];
    const outputs: Record<string, unknown> = {};

    validateInvocation(request);
    await this.observer.record({ runId, phase: "discovery", type: "run_started", details: { goal: request.goal } });
    for (let stepNumber = 0; stepNumber < maxSteps; stepNumber += 1) {
      const observation = await this.surface.observe();
      const action = await this.decisions.decide({
        goal: request.goal,
        step: stepNumber,
        observation,
        history: turns,
        availableInputs: request.contract.inputs.map((input) => input.name),
        declaredOutputs: request.contract.outputs.map((output) => output.name),
        completedOutputs: Object.keys(outputs)
      });
      const turn: DiscoveryTurn = { step: stepNumber, observation, action };
      turns.push(turn);
      await this.observer.record({
        runId, phase: "discovery", type: "action_selected",
        details: { step: stepNumber, action }
      });

      if (action.action === "finish") {
        try {
          await verifyCheckpoint(this.surface, action.success);
        } catch (error) {
          turn.error = `Completion rejected: ${messageOf(error)}`;
          await this.observer.record({ runId, phase: "discovery", type: "completion_rejected", details: { message: turn.error } });
          continue;
        }
        const artifact = capabilityArtifactSchema.parse({
          schemaVersion: "1.0",
          capability: request.capability,
          contract: request.contract,
          steps: recordedSteps,
          success: action.success,
          metadata: { createdAt: new Date().toISOString(), discoveryRunId: runId }
        });
        await this.observer.record({ runId, phase: "discovery", type: "run_succeeded", details: { outputs } });
        return { runId, artifact, outputs, turns };
      }

      try {
        validateRecordedAction(action, request, recordedSteps);
        const currentUrl = (await this.surface.observe()).url;
        const navigationUrl = action.action === "navigate" ? bind(action.url, request) : undefined;
        await this.policy.authorize(action, currentUrl, navigationUrl);
        await executeAction(this.surface, action, request, outputs);
        if (action.checkpoint) await verifyCheckpoint(this.surface, action.checkpoint);
        recordedSteps.push(action);
        await this.observer.record({ runId, phase: "discovery", type: "step_succeeded", stepId: action.id });
      } catch (error) {
        turn.error = `Action rejected: ${messageOf(error)}`;
        await this.observer.record({
          runId, phase: "discovery", type: "step_rejected", stepId: action.id,
          details: { message: turn.error }
        });
      }
    }
    await this.observer.record({ runId, phase: "discovery", type: "run_failed", details: { code: "max_steps", maxSteps } });
    throw new DiscoveryStoppedError(`Discovery exceeded its ${maxSteps}-step limit`, turns);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeAction(
  surface: Surface,
  action: CapabilityStep,
  request: DiscoveryRequest,
  outputs: Record<string, unknown>
): Promise<void> {
  switch (action.action) {
    case "navigate":
      await surface.navigate(bind(action.url, request));
      break;
    case "click":
      await surface.click(action.target);
      break;
    case "fill":
      await surface.fill(action.target, bind(action.value, request));
      break;
    case "extract":
      {
        const value = await surface.extractText(action.target);
        validateOutput(action.output, value, request.contract);
        outputs[action.output] = value;
      }
      break;
    case "wait":
      await verifyCheckpoint(surface, action.for);
      break;
  }
}

async function verifyCheckpoint(surface: Surface, checkpoint: Checkpoint): Promise<void> {
  if (checkpoint.kind === "url") {
    const observed = (await surface.observe()).url;
    if (!new RegExp(checkpoint.matches).test(observed)) {
      throw new Error(`URL checkpoint failed: expected ${checkpoint.matches}, observed ${observed}`);
    }
    return;
  }
  const observed = await surface.extractText(checkpoint.target);
  if (checkpoint.kind === "text" && !new RegExp(checkpoint.matches).test(observed)) {
    throw new Error(`Text checkpoint failed: expected ${checkpoint.matches}, observed ${observed}`);
  }
}

function bind(template: string, request: DiscoveryRequest): string {
  return template.replace(/\$\{(inputs\.([a-z][a-z0-9_]*)|target\.entrypoint)\}/g, (token, expression: string, inputName?: string) => {
    if (expression === "target.entrypoint") return request.capability.target.entrypoint;
    if (inputName && inputName in request.inputs) return String(request.inputs[inputName]);
    throw new Error(`Unresolved template value ${token}`);
  });
}

function validateInvocation(request: DiscoveryRequest): void {
  for (const input of request.contract.inputs) {
    const value = request.inputs[input.name];
    if (input.required && value === undefined) throw new Error(`Missing required input: ${input.name}`);
    if (value !== undefined && typeof value !== input.type) throw new Error(`Input ${input.name} must be ${input.type}`);
  }
}

function validateRecordedAction(action: CapabilityStep, request: DiscoveryRequest, recordedSteps: readonly CapabilityStep[]): void {
  if (recordedSteps.some((step) => step.id === action.id)) throw new Error(`Duplicate step ID: ${action.id}`);
  if (action.action !== "fill") return;
  for (const input of request.contract.inputs) {
    const runtimeValue = request.inputs[input.name];
    if (runtimeValue !== undefined && action.value === String(runtimeValue)) {
      throw new Error(`Runtime input ${input.name} must be recorded as \${inputs.${input.name}}`);
    }
  }
}

function validateOutput(name: string, value: unknown, contract: DiscoveryRequest["contract"]): void {
  const output = contract.outputs.find((candidate) => candidate.name === name);
  if (!output) throw new Error(`Output ${name} is not declared`);
  if (typeof value !== output.type) throw new Error(`Output ${name} must be ${output.type}`);
  if (output.pattern && !new RegExp(output.pattern).test(String(value))) {
    throw new Error(`Output ${name} did not match its declared pattern`);
  }
}

export const targets = {
  memberNumber: {
    description: "Member Number input",
    locators: [
      { strategy: "label", value: "Member Number", exact: true },
      { strategy: "css", value: "input[name=memberId]", exact: true }
    ],
    requireUnique: true
  },
  search: {
    description: "Search button",
    locators: [{ strategy: "role", role: "button", value: "Search", exact: true }],
    requireUnique: true
  },
  savingsLink: {
    description: "Savings account link",
    locators: [{ strategy: "role", role: "link", value: "View Account", exact: true }],
    requireUnique: true
  },
  balance: {
    description: "Current balance",
    locators: [{ strategy: "css", value: "[data-field=current-balance]", exact: true }],
    requireUnique: true
  },
  savingsTable: {
    description: "Savings account table",
    locators: [{ strategy: "role", role: "table", value: "Savings account", exact: true }],
    requireUnique: true
  }
} satisfies Record<string, ControlTarget>;
