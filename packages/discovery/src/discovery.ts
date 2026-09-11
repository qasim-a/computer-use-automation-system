import { randomUUID } from "node:crypto";
import {
  capabilityArtifactSchema,
  type CapabilityArtifact,
  type CapabilityStep,
  type ControlTarget
} from "../../contracts/src/index.js";
import type { Surface, SurfaceObservation } from "../../surface/src/index.js";

type Checkpoint = NonNullable<CapabilityStep["checkpoint"]>;

export type DiscoveryAction =
  | CapabilityStep
  | { action: "finish"; description: string; success: Checkpoint };

export type DiscoveryTurn = {
  step: number;
  observation: SurfaceObservation;
  action: DiscoveryAction;
};

export type DecisionContext = {
  goal: string;
  step: number;
  observation: SurfaceObservation;
  history: readonly DiscoveryTurn[];
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
  constructor(private readonly surface: Surface, private readonly decisions: DecisionProvider) {}

  async run(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const runId = randomUUID();
    const maxSteps = request.maxSteps ?? 12;
    const turns: DiscoveryTurn[] = [];
    const recordedSteps: CapabilityStep[] = [];
    const outputs: Record<string, unknown> = {};

    validateInvocation(request);
    for (let stepNumber = 0; stepNumber < maxSteps; stepNumber += 1) {
      const observation = await this.surface.observe();
      const action = await this.decisions.decide({
        goal: request.goal,
        step: stepNumber,
        observation,
        history: turns
      });
      turns.push({ step: stepNumber, observation, action });

      if (action.action === "finish") {
        await verifyCheckpoint(this.surface, action.success);
        const artifact = capabilityArtifactSchema.parse({
          schemaVersion: "1.0",
          capability: request.capability,
          contract: request.contract,
          steps: recordedSteps,
          success: action.success,
          metadata: { createdAt: new Date().toISOString(), discoveryRunId: runId }
        });
        return { runId, artifact, outputs, turns };
      }

      await executeAction(this.surface, action, request, outputs);
      if (action.checkpoint) await verifyCheckpoint(this.surface, action.checkpoint);
      recordedSteps.push(action);
    }
    throw new DiscoveryStoppedError(`Discovery exceeded its ${maxSteps}-step limit`, turns);
  }
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
      outputs[action.output] = await surface.extractText(action.target);
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
