import { randomUUID } from "node:crypto";
import {
  capabilityArtifactSchema,
  replayResultSchema,
  type CapabilityArtifact,
  type CapabilityStep,
  type ReplayResult
} from "../../contracts/src/index.js";
import type { Surface } from "../../surface/src/index.js";
import { ActionPolicy } from "../../policy/src/index.js";
import type { HandoffController } from "../../handoff/src/index.js";
import { NoopRunObserver, type RunObserver } from "../../observability/src/index.js";

export class ReplayEngine {
  constructor(
    private readonly surface: Surface,
    private readonly policy = ActionPolicy.localDevelopment(),
    private readonly handoff?: HandoffController,
    private readonly observer: RunObserver = new NoopRunObserver()
  ) {}

  async run(untrustedArtifact: unknown, inputs: Record<string, unknown>): Promise<ReplayResult> {
    const startedAt = performance.now();
    const runId = randomUUID();
    let artifact: CapabilityArtifact;
    try {
      artifact = capabilityArtifactSchema.parse(untrustedArtifact);
    } catch (error) {
      await this.observer.record({ runId, phase: "replay", type: "run_rejected", details: { code: "invalid_artifact" } });
      return this.failure(runId, "invalid_artifact", "Artifact validation failed", startedAt, undefined, error);
    }

    const inputError = validateInputs(artifact, inputs);
    if (inputError) {
      await this.observer.record({ runId, phase: "replay", type: "run_rejected", details: { code: "invalid_inputs", message: inputError } });
      return this.failure(runId, "invalid_inputs", inputError, startedAt, artifact);
    }

    const outputs: Record<string, unknown> = {};
    await this.observer.record({
      runId, phase: "replay", type: "run_started",
      details: { capability: artifact.capability.name, version: artifact.capability.version }
    });
    let activeStep: CapabilityStep | undefined;
    try {
      for (const step of artifact.steps) {
        activeStep = step;
        try {
          await this.executeWithRetry(runId, step, artifact, inputs, outputs);
        } catch (error) {
          const outcome = await this.detectBusinessOutcome(artifact, inputs);
          if (outcome) {
            await this.observer.record({
              runId, phase: "replay", type: "business_outcome", stepId: step.id,
              details: { code: outcome.code, message: outcome.message }
            });
            return replayResultSchema.parse({
              runId,
              capabilityName: artifact.capability.name,
              capabilityVersion: artifact.capability.version,
              durationMs: performance.now() - startedAt,
              status: "business_outcome",
              outcome: outcome.code,
              message: outcome.message
            });
          }
          throw error;
        }
      }
      await this.verify(artifact.success, artifact, inputs);
      await this.observer.record({ runId, phase: "replay", type: "run_succeeded", details: { outputs } });
      return replayResultSchema.parse({
        runId,
        capabilityName: artifact.capability.name,
        capabilityVersion: artifact.capability.version,
        durationMs: performance.now() - startedAt,
        status: "success",
        outputs
      });
    } catch (error) {
      const screenshot = await this.observer.captureFailure(this.surface, runId, activeStep?.id);
      await this.observer.record({
        runId, phase: "replay", type: "run_failed", ...(activeStep?.id ? { stepId: activeStep.id } : {}),
        details: { code: "step_failed", message: messageOf(error), ...(screenshot ? { screenshot } : {}) }
      });
      return this.failure(runId, "step_failed", messageOf(error), startedAt, artifact, error, activeStep?.id, screenshot);
    }
  }

  private async executeWithRetry(
    runId: string,
    step: CapabilityStep,
    artifact: CapabilityArtifact,
    inputs: Record<string, unknown>,
    outputs: Record<string, unknown>
  ): Promise<void> {
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.observer.record({
          runId, phase: "replay", type: "step_started", stepId: step.id,
          details: { action: step.action, attempt, maxAttempts }
        });
        const currentUrl = (await this.surface.observe()).url;
        const navigationUrl = step.action === "navigate" ? bind(step.url, artifact, inputs) : undefined;
        await this.policy.authorize(step, currentUrl, navigationUrl);
        await this.execute(step, artifact, inputs, outputs);
        if (step.checkpoint) await this.verify(step.checkpoint, artifact, inputs);
        await this.observer.record({ runId, phase: "replay", type: "step_succeeded", stepId: step.id, details: { attempt } });
        return;
      } catch (error) {
        lastError = error;
        const outcome = await this.detectBusinessOutcome(artifact, inputs);
        if (outcome) {
          await this.observer.record({
            runId, phase: "replay", type: "step_stopped_for_outcome", stepId: step.id,
            details: { attempt, outcome: outcome.code }
          });
          throw error;
        }
        await this.observer.record({
          runId, phase: "replay", type: attempt < maxAttempts ? "step_retrying" : "step_exhausted",
          stepId: step.id, details: { attempt, message: messageOf(error) }
        });
        if (attempt < maxAttempts && step.retry) await delay(step.retry.delayMs);
      }
    }
    if (this.handoff) {
      await this.handoff.requestIntervention({
        capabilityName: artifact.capability.name,
        stepId: step.id,
        reason: messageOf(lastError)
      });
      const currentUrl = (await this.surface.observe()).url;
      const navigationUrl = step.action === "navigate" ? bind(step.url, artifact, inputs) : undefined;
      await this.policy.authorize(step, currentUrl, navigationUrl);
      await this.execute(step, artifact, inputs, outputs);
      if (step.checkpoint) await this.verify(step.checkpoint, artifact, inputs);
      return;
    }
    throw lastError;
  }

  private async detectBusinessOutcome(artifact: CapabilityArtifact, inputs: Record<string, unknown>) {
    for (const outcome of artifact.businessOutcomes) {
      try {
        await this.verify(outcome.checkpoint, artifact, inputs);
        return outcome;
      } catch {
        // A non-match is expected while checking alternative declared outcomes.
      }
    }
    return undefined;
  }

  private async execute(
    step: CapabilityStep,
    artifact: CapabilityArtifact,
    inputs: Record<string, unknown>,
    outputs: Record<string, unknown>
  ): Promise<void> {
    switch (step.action) {
      case "navigate":
        await this.surface.navigate(bind(step.url, artifact, inputs));
        break;
      case "click":
        await this.surface.click(step.target);
        break;
      case "fill":
        await this.surface.fill(step.target, bind(step.value, artifact, inputs));
        break;
      case "extract":
        {
          const value = await this.surface.extractText(step.target);
          const declaration = artifact.contract.outputs.find((output) => output.name === step.output);
          if (!declaration) throw new Error(`Output ${step.output} is not declared`);
          if (typeof value !== declaration.type) throw new Error(`Output ${step.output} must be ${declaration.type}`);
          if (declaration.pattern && !new RegExp(declaration.pattern).test(String(value))) {
            throw new Error(`Output ${step.output} did not match its declared pattern`);
          }
          outputs[step.output] = value;
        }
        break;
      case "wait":
        await this.verify(step.for, artifact, inputs);
        break;
    }
  }

  private async verify(
    checkpoint: CapabilityStep["checkpoint"] | CapabilityArtifact["success"],
    artifact: CapabilityArtifact,
    inputs: Record<string, unknown>
  ): Promise<void> {
    if (!checkpoint) return;
    if (checkpoint.kind === "url") {
      const observation = await this.surface.observe();
      const expected = bind(checkpoint.matches, artifact, inputs);
      if (!new RegExp(expected).test(observation.url)) throw new Error(`URL checkpoint failed: expected ${expected}, observed ${observation.url}`);
      return;
    }
    const text = await this.surface.extractText(checkpoint.target);
    if (checkpoint.kind === "text" && !new RegExp(bind(checkpoint.matches, artifact, inputs)).test(text)) {
      throw new Error(`Text checkpoint failed: expected ${checkpoint.matches}, observed ${text}`);
    }
  }

  private failure(
    runId: string,
    code: string,
    message: string,
    startedAt: number,
    artifact?: CapabilityArtifact,
    error?: unknown,
    stepId?: string,
    screenshot?: string
  ): ReplayResult {
    return replayResultSchema.parse({
      runId,
      capabilityName: artifact?.capability.name ?? "invalid_artifact",
      capabilityVersion: artifact?.capability.version ?? "unknown",
      durationMs: performance.now() - startedAt,
      status: "failure",
      error: {
        code,
        message,
        ...(stepId ? { stepId } : {}),
        ...(error ? { observed: messageOf(error) } : {}),
        evidence: screenshot ? [screenshot] : []
      }
    });
  }
}

function bind(template: string, artifact: CapabilityArtifact, inputs: Record<string, unknown>): string {
  return template.replace(/\$\{(inputs\.([a-z][a-z0-9_]*)|target\.entrypoint)\}/g, (token, expression: string, inputName?: string) => {
    if (expression === "target.entrypoint") return artifact.capability.target.entrypoint;
    if (inputName && inputName in inputs) return String(inputs[inputName]);
    throw new Error(`Unresolved template value ${token}`);
  });
}

function validateInputs(artifact: CapabilityArtifact, inputs: Record<string, unknown>): string | undefined {
  const declared = new Set(artifact.contract.inputs.map((input) => input.name));
  const unknown = Object.keys(inputs).find((name) => !declared.has(name));
  if (unknown) return `Unknown input: ${unknown}`;
  for (const input of artifact.contract.inputs) {
    const value = inputs[input.name];
    if (input.required && value === undefined) return `Missing required input: ${input.name}`;
    if (value !== undefined && typeof value !== input.type) return `Input ${input.name} must be ${input.type}`;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
