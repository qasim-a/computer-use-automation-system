import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ControlTarget } from "../../contracts/src/index.js";
import type { Surface, SurfaceObservation } from "../../surface/src/index.js";

export type ControlOwner = "automation" | "handoff_requested" | "human" | "automation_resuming";

export type InterventionContext = {
  runId: string;
  capabilityName: string;
  capabilityVersion: string;
  goal?: string;
  stepId: string;
  failure: { code: string; message: string; attempts: number };
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
  reject: (error: Error) => void;
  actions: HumanAction[];
};

export interface InterventionRouter {
  route(request: InterventionRequest): Promise<void>;
}

export type HandoffOptions = {
  evidenceDirectory?: string;
  timeoutMs?: number;
  router?: InterventionRouter;
};

export class HandoffStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffStateError";
  }
}

export class HandoffTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffTimeoutError";
  }
}

export class HandoffCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffCancelledError";
  }
}

export class HandoffController {
  private owner: ControlOwner = "automation";
  private pending: PendingHandoff | undefined;

  constructor(private readonly surface: Surface, private readonly options: HandoffOptions = {}) {}

  ownership(): ControlOwner {
    return this.owner;
  }

  currentRequest(): InterventionRequest | undefined {
    return this.pending?.request;
  }

  async requestIntervention(context: InterventionContext, sensitiveValues: readonly unknown[] = []): Promise<HandoffResolution> {
    if (this.owner !== "automation") throw new HandoffStateError(`Cannot request handoff while owner is ${this.owner}`);
    const id = randomUUID();
    const observation = redactObservation(await this.surface.observe(), sensitiveValues);
    let screenshot: string | undefined;
    if (this.options.evidenceDirectory) {
      await mkdir(this.options.evidenceDirectory, { recursive: true });
      screenshot = resolve(this.options.evidenceDirectory, `${id}.png`);
      await this.surface.screenshot(screenshot, { maskSensitive: true });
    }
    const request: InterventionRequest = {
      ...context, id, createdAt: new Date().toISOString(), observation, ...(screenshot ? { screenshot } : {})
    };
    this.owner = "handoff_requested";
    const timeoutMs = this.options.timeoutMs ?? 300_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resolution = new Promise<HandoffResolution>((resolveHandoff, rejectHandoff) => {
      this.pending = {
        request,
        resolve: resolveHandoff,
        reject: rejectHandoff,
        actions: []
      };
      timeout = setTimeout(
        () => rejectHandoff(new HandoffTimeoutError(`No operator accepted intervention ${id} within ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      await this.options.router?.route(request);
      return await resolution;
    } finally {
      if (timeout) clearTimeout(timeout);
      this.pending = undefined;
      this.owner = "automation";
    }
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

  cancel(reason: string): void {
    if (!this.pending || (this.owner !== "handoff_requested" && this.owner !== "human")) {
      throw new HandoffStateError(`Cannot cancel handoff while owner is ${this.owner}`);
    }
    this.pending.reject(new HandoffCancelledError(reason));
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

function redactObservation(observation: SurfaceObservation, sensitiveValues: readonly unknown[]): SurfaceObservation {
  const values = [
    ...sensitiveValues.map(String),
    ...observation.dataFields.map((field) => field.text)
  ].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  const redact = (text: string) => values.reduce((safe, value) => safe.replaceAll(value, "[REDACTED]"), text);
  return {
    ...observation,
    url: redact(observation.url),
    visibleText: redact(observation.visibleText),
    dataFields: observation.dataFields.map((field) => ({ ...field, text: "[REDACTED]" }))
  };
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
