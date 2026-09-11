import type { CapabilityStep } from "../../contracts/src/index.js";

export type RiskLevel = "read_only" | "reversible" | "irreversible";

export type ApprovalRequest = {
  step: CapabilityStep;
  risk: RiskLevel;
  url: string;
};

export type ApprovalProvider = (request: ApprovalRequest) => Promise<boolean>;

export type PolicyConfig = {
  allowedOriginPatterns: string[];
  allowedPathPatterns: string[];
  allowedActions: CapabilityStep["action"][];
  requireApprovalFor: RiskLevel[];
};

export class PolicyViolationError extends Error {
  constructor(message: string, readonly stepId: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export class ActionPolicy {
  constructor(private readonly config: PolicyConfig, private readonly approve?: ApprovalProvider) {}

  static localDevelopment(): ActionPolicy {
    return new ActionPolicy({
      allowedOriginPatterns: ["^http://(127\\.0\\.0\\.1|localhost)(:\\d+)?$"],
      allowedPathPatterns: ["^/members(?:/|$)", "^/$"],
      allowedActions: ["navigate", "click", "fill", "extract", "wait"],
      requireApprovalFor: ["irreversible"]
    });
  }

  async authorize(step: CapabilityStep, currentUrl: string, navigationUrl?: string): Promise<void> {
    if (!this.config.allowedActions.includes(step.action)) {
      throw new PolicyViolationError(`Action ${step.action} is not allowed`, step.id);
    }

    const effectiveUrl = step.action === "navigate" ? navigationUrl : currentUrl;
    if (!effectiveUrl) throw new PolicyViolationError("Navigation target is missing", step.id);
    this.authorizeUrl(effectiveUrl, step.id);

    const risk = riskOf(step);
    if (this.config.requireApprovalFor.includes(risk)) {
      const approved = await this.approve?.({ step, risk, url: effectiveUrl });
      if (!approved) throw new PolicyViolationError(`Action requires ${risk} approval`, step.id);
    }
  }

  private authorizeUrl(rawUrl: string, stepId: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new PolicyViolationError(`Invalid URL: ${rawUrl}`, stepId);
    }
    if (!this.config.allowedOriginPatterns.some((pattern) => new RegExp(pattern).test(url.origin))) {
      throw new PolicyViolationError(`Origin is not allowed: ${url.origin}`, stepId);
    }
    if (!this.config.allowedPathPatterns.some((pattern) => new RegExp(pattern).test(url.pathname))) {
      throw new PolicyViolationError(`Path is not allowed: ${url.pathname}`, stepId);
    }
  }
}

export function riskOf(step: CapabilityStep): RiskLevel {
  if (step.risk) return step.risk;
  return step.action === "fill" || step.action === "click" ? "reversible" : "read_only";
}
