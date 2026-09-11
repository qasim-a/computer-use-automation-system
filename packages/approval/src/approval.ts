import { createHash } from "node:crypto";
import {
  capabilityArtifactSchema,
  type CapabilityArtifact,
  type ReplayResult
} from "../../contracts/src/index.js";

export type StabilityAssessment = {
  totalRuns: number;
  successfulRuns: number;
  successRate: number;
  consistentOutputs: boolean;
};

export type ApprovalCriteria = {
  minimumRuns: number;
  minimumSuccessRate: number;
  requireConsistentOutputs: boolean;
};

export const defaultApprovalCriteria: ApprovalCriteria = {
  minimumRuns: 3,
  minimumSuccessRate: 1,
  requireConsistentOutputs: true
};

export class ApprovalRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRejectedError";
  }
}

export function assessStability(results: readonly ReplayResult[]): StabilityAssessment {
  const successful = results.filter((result) => result.status === "success");
  const serializedOutputs = successful.map((result) => stableStringify(result.status === "success" ? result.outputs : {}));
  return {
    totalRuns: results.length,
    successfulRuns: successful.length,
    successRate: results.length === 0 ? 0 : successful.length / results.length,
    consistentOutputs: serializedOutputs.length > 0 && new Set(serializedOutputs).size === 1
  };
}

export function approveArtifact(
  untrustedArtifact: unknown,
  reviewer: string,
  stability: StabilityAssessment,
  criteria: ApprovalCriteria = defaultApprovalCriteria
): CapabilityArtifact {
  const artifact = capabilityArtifactSchema.parse(untrustedArtifact);
  if (!reviewer.trim()) throw new ApprovalRejectedError("Reviewer identity is required");
  if (stability.totalRuns < criteria.minimumRuns) {
    throw new ApprovalRejectedError(`Approval requires at least ${criteria.minimumRuns} replay runs`);
  }
  if (stability.successRate < criteria.minimumSuccessRate) {
    throw new ApprovalRejectedError(`Replay success rate ${stability.successRate} is below ${criteria.minimumSuccessRate}`);
  }
  if (criteria.requireConsistentOutputs && !stability.consistentOutputs) {
    throw new ApprovalRejectedError("Successful replay outputs were inconsistent");
  }
  const payload = approvalPayload(artifact);
  const approval = {
    approvedAt: new Date().toISOString(),
    approvedBy: reviewer,
    stability
  };
  return capabilityArtifactSchema.parse({
    ...payload,
    lifecycle: "approved",
    approval: {
      ...approval,
      artifactDigest: digestApproval(payload, approval)
    }
  });
}

export function verifyArtifactApproval(artifact: CapabilityArtifact): string | undefined {
  if (artifact.lifecycle !== "approved" || !artifact.approval) return "Artifact is not approved";
  const { artifactDigest: _digest, ...approval } = artifact.approval;
  const actual = digestApproval(approvalPayload(artifact), approval);
  if (actual !== artifact.approval.artifactDigest) return "Artifact changed after approval";
  return undefined;
}

function approvalPayload(artifact: CapabilityArtifact): Omit<CapabilityArtifact, "approval"> {
  const { approval: _approval, ...payload } = artifact;
  return { ...payload, lifecycle: "draft" };
}

function digestApproval(payload: unknown, approval: unknown): string {
  return createHash("sha256").update(stableStringify({ payload, approval })).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
