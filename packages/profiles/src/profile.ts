import { z } from "zod";
import {
  capabilityArtifactSchema,
  locatorSchema,
  type CapabilityArtifact,
  type CapabilityStep,
  type ControlTarget
} from "../../contracts/src/index.js";
import type { PolicyConfig } from "../../policy/src/index.js";

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const riskLevel = z.enum(["read_only", "reversible", "irreversible"]);

export const applicationProfileSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: identifier,
  app: identifier,
  appVersion: z.string().min(1),
  surface: z.literal("web"),
  defaultEntrypoint: z.string().url(),
  policy: z.object({
    allowedOriginPatterns: z.array(z.string().min(1)).min(1),
    allowedPathPatterns: z.array(z.string().min(1)).min(1),
    allowedActions: z.array(z.enum(["navigate", "click", "fill", "extract", "wait"])).min(1),
    requireApprovalFor: z.array(riskLevel)
  })
});

export const tenantOverlaySchema = z.object({
  schemaVersion: z.literal("1.0"),
  tenantId: identifier,
  profileId: identifier,
  entrypoint: z.string().url().optional(),
  locatorOverrides: z.record(identifier, z.array(locatorSchema).min(1)).default({})
});

export type ApplicationProfile = z.infer<typeof applicationProfileSchema>;
export type TenantOverlay = z.infer<typeof tenantOverlaySchema>;
export type CompiledCapability = { artifact: CapabilityArtifact; policy: PolicyConfig; tenantId?: string };

export function compileCapability(
  untrustedArtifact: unknown,
  untrustedProfile: unknown,
  untrustedOverlay?: unknown
): CompiledCapability {
  const artifact = capabilityArtifactSchema.parse(untrustedArtifact);
  const profile = applicationProfileSchema.parse(untrustedProfile);
  const overlay = untrustedOverlay === undefined ? undefined : tenantOverlaySchema.parse(untrustedOverlay);
  if (
    artifact.capability.target.app !== profile.app
    || artifact.capability.target.surface !== profile.surface
    || artifact.capability.target.appVersion !== profile.appVersion
  ) {
    throw new Error(`Capability target is incompatible with profile ${profile.id}`);
  }
  if (overlay && overlay.profileId !== profile.id) throw new Error(`Tenant overlay requires profile ${overlay.profileId}`);

  const compiled = structuredClone(artifact);
  compiled.lifecycle = "draft";
  delete compiled.approval;
  compiled.capability.target.appVersion = profile.appVersion;
  compiled.capability.target.entrypoint = overlay?.entrypoint ?? profile.defaultEntrypoint;
  const unmatched = new Set(Object.keys(overlay?.locatorOverrides ?? {}));
  visitTargets(compiled, (target) => {
    if (!target.key) return;
    const replacement = overlay?.locatorOverrides[target.key];
    if (!replacement) return;
    target.locators = structuredClone(replacement);
    unmatched.delete(target.key);
  });
  if (unmatched.size > 0) throw new Error(`Overlay contains unknown target keys: ${[...unmatched].join(", ")}`);

  return {
    artifact: capabilityArtifactSchema.parse(compiled),
    policy: profile.policy,
    ...(overlay ? { tenantId: overlay.tenantId } : {})
  };
}

function visitTargets(artifact: CapabilityArtifact, visit: (target: ControlTarget) => void): void {
  const checkpoint = (value: CapabilityStep["checkpoint"] | CapabilityArtifact["success"]) => {
    if (value && value.kind !== "url") visit(value.target);
  };
  for (const step of artifact.steps) {
    if (step.action === "click" || step.action === "fill" || step.action === "extract") visit(step.target);
    if (step.action === "wait") checkpoint(step.for);
    checkpoint(step.checkpoint);
  }
  for (const outcome of artifact.businessOutcomes) checkpoint(outcome.checkpoint);
  checkpoint(artifact.success);
}
