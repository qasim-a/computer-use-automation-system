import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ControlTarget } from "../../contracts/src/index.js";
import type { Surface, SurfaceObservation } from "../../surface/src/index.js";

export type ControlOwner = "automation" | "handoff_requested" | "human" | "automation_resuming";

export type InterventionContext = {
  capabilityName: string;
  goal?: string;
  stepId: string;
  reason: string;
};

export type InterventionRequest = InterventionContext & {
  id: string;
  createdAt: string;
  observation: SurfaceObservation;
  screenshot?: string;
};

export type HumanAction = {
  timestamp: string;
  operator: string;
  action: "navigate" | "click" | "fill" | "resume";
  description: string;
};

export type HandoffResolution = {
  operator: string;
  note: string;
  actions: HumanAction[];
};

type PendingHandoff = {
  request: InterventionRequest;
  resolve: (resolution: HandoffResolution) => void;
  actions: HumanAction[];
};

export class HandoffStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffStateError";
  }
}

export class HandoffController {
  private owner: ControlOwner = "automation";
  private pending: PendingHandoff | undefined;

  constructor(private readonly surface: Surface, private readonly evidenceDirectory?: string) {}

  ownership(): ControlOwner {
    return this.owner;
  }

  currentRequest(): InterventionRequest | undefined {
    return this.pending?.request;
  }

  async requestIntervention(context: InterventionContext): Promise<HandoffResolution> {
    if (this.owner !== "automation") throw new HandoffStateError(`Cannot request handoff while owner is ${this.owner}`);
    const id = randomUUID();
    const observation = await this.surface.observe();
    let screenshot: string | undefined;
    if (this.evidenceDirectory) {
      await mkdir(this.evidenceDirectory, { recursive: true });
      screenshot = resolve(this.evidenceDirectory, `${id}.png`);
      await this.surface.screenshot(screenshot);
    }
    this.owner = "handoff_requested";
    const resolution = await new Promise<HandoffResolution>((resolveHandoff) => {
      this.pending = {
        request: { ...context, id, createdAt: new Date().toISOString(), observation, ...(screenshot ? { screenshot } : {}) },
        resolve: resolveHandoff,
        actions: []
      };
    });
    this.pending = undefined;
    this.owner = "automation";
    return resolution;
  }

  takeControl(operator: string): OperatorSession {
    if (this.owner !== "handoff_requested" || !this.pending) {
      throw new HandoffStateError(`Cannot take control while owner is ${this.owner}`);
    }
    if (!operator.trim()) throw new HandoffStateError("Operator identity is required");
    this.owner = "human";
    return new OperatorSession(this, this.surface, operator);
  }

  record(action: HumanAction): void {
    if (this.owner !== "human" || !this.pending) throw new HandoffStateError("Human does not own the session");
    this.pending.actions.push(action);
  }

  resume(operator: string, note: string): void {
    if (this.owner !== "human" || !this.pending) throw new HandoffStateError("Cannot resume without human control");
    const action: HumanAction = {
      timestamp: new Date().toISOString(), operator, action: "resume", description: note
    };
    this.pending.actions.push(action);
    this.owner = "automation_resuming";
    this.pending.resolve({ operator, note, actions: [...this.pending.actions] });
  }
}

export class OperatorSession {
  constructor(
    private readonly controller: HandoffController,
    private readonly surface: Surface,
    private readonly operator: string
  ) {}

  async navigate(url: string): Promise<void> {
    await this.surface.navigate(url);
    this.log("navigate", url);
  }

  async click(target: ControlTarget): Promise<void> {
    await this.surface.click(target);
    this.log("click", target.description);
  }

  async fill(target: ControlTarget, value: string): Promise<void> {
    await this.surface.fill(target, value);
    this.log("fill", `${target.description} (value redacted)`);
  }

  resume(note: string): void {
    this.controller.resume(this.operator, note);
  }

  private log(action: HumanAction["action"], description: string): void {
    this.controller.record({ timestamp: new Date().toISOString(), operator: this.operator, action, description });
  }
}
