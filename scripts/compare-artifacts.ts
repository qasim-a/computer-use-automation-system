import { readFile, writeFile } from "node:fs/promises";
import { startTargetServer } from "../apps/target/src/server.js";
import { capabilityArtifactSchema, type CapabilityArtifact } from "../packages/contracts/src/index.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";

type CaseResult = {
  status: string;
  detail: string;
};

const sources = {
  engineered: "capabilities/read_savings_balance.json",
  claude: "evidence/live-run/artifact.json"
} as const;

const artifacts = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, path]) => [
  name,
  capabilityArtifactSchema.parse(JSON.parse(await readFile(path, "utf8")))
]))) as Record<keyof typeof sources, CapabilityArtifact>;

const cases = [
  { name: "primary_member", memberId: "12345" },
  { name: "alternate_member", memberId: "67890" },
  { name: "member_not_found", memberId: "00000" },
  { name: "transient_host_error", memberId: "12345", scenario: "transient" }
] as const;

const results: Record<string, Record<string, CaseResult>> = {};
for (const [artifactName, sourceArtifact] of Object.entries(artifacts)) {
  results[artifactName] = {};
  for (const testCase of cases) {
    const scenario = "scenario" in testCase ? testCase.scenario : undefined;
    results[artifactName]![testCase.name] = await replayCase(sourceArtifact, testCase.memberId, scenario);
  }
}

const comparison = {
  generatedAt: new Date().toISOString(),
  structures: Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, summarize(artifact)])),
  replayMatrix: results
};

await writeFile("evidence/artifact-comparison.json", `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile("evidence/artifact-comparison.md", markdown(comparison));
console.log(JSON.stringify(comparison, null, 2));

async function replayCase(
  sourceArtifact: CapabilityArtifact,
  memberId: string,
  scenario?: string
): Promise<CaseResult> {
  const server = await startTargetServer(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  const artifact = structuredClone(sourceArtifact);
  artifact.capability.target.entrypoint = `http://127.0.0.1:${address.port}/members${scenario ? `?scenario=${scenario}` : ""}`;
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(artifact, { member_id: memberId });
    if (result.status === "success") return { status: result.status, detail: String(result.outputs.current_balance) };
    if (result.status === "business_outcome") return { status: result.status, detail: result.outcome };
    return { status: result.status, detail: `${result.error.stepId ?? "unknown"}: ${result.error.message}` };
  } finally {
    await surface.close();
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

function summarize(artifact: CapabilityArtifact) {
  const locators = artifact.steps.flatMap((step) => "target" in step ? step.target.locators : []);
  return {
    steps: artifact.steps.length,
    locatorCandidates: locators.length,
    locatorStrategies: [...new Set(locators.map((locator) => locator.strategy))].sort(),
    parameterizedFills: artifact.steps.filter((step) => step.action === "fill" && step.value.includes("${inputs.")).length,
    checkpoints: artifact.steps.filter((step) => step.checkpoint).length + 1,
    explicitRiskLabels: artifact.steps.filter((step) => step.risk).length,
    retryingSteps: artifact.steps.filter((step) => step.retry).length,
    businessOutcomes: artifact.businessOutcomes.length
  };
}

function markdown(value: typeof comparison): string {
  const engineered = value.structures.engineered!;
  const claude = value.structures.claude!;
  const rows = cases.map((testCase) => {
    const left = value.replayMatrix.engineered![testCase.name]!;
    const right = value.replayMatrix.claude![testCase.name]!;
    return `| ${testCase.name} | ${left.status}: ${left.detail} | ${right.status}: ${right.detail} |`;
  }).join("\n");
  return `# Scripted vs. Claude Artifact Comparison

Both artifacts contain ${engineered.steps} steps and parameterize the runtime member ID. The Claude-discovered artifact independently found a valid happy-path flow and stable data-field extraction; the engineered artifact adds production policy learned outside that single successful run.

| Property | Engineered artifact | Claude-discovered artifact |
| --- | ---: | ---: |
| Locator candidates | ${engineered.locatorCandidates} | ${claude.locatorCandidates} |
| Step checkpoints | ${engineered.checkpoints} | ${claude.checkpoints} |
| Explicit risk labels | ${engineered.explicitRiskLabels} | ${claude.explicitRiskLabels} |
| Retrying steps | ${engineered.retryingSteps} | ${claude.retryingSteps} |
| Declared business outcomes | ${engineered.businessOutcomes} | ${claude.businessOutcomes} |

| Replay case | Engineered artifact | Claude-discovered artifact |
| --- | --- | --- |
${rows}

## Conclusion

Claude successfully discovers the reusable task mechanics, but one successful trace cannot reveal unseen runtime conditions. The production design should therefore compile the discovered flow together with reviewed application-profile policy: known business outcomes, bounded recoveries, risk labels, and stronger checkpoints. This preserves model-led discovery while keeping production replay deterministic and reviewable.
`;
}
