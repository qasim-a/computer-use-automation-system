import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startTargetServer } from "../apps/target/src/server.js";
import { AnthropicDecisionProvider, DiscoveryRunner } from "../packages/discovery/src/index.js";
import { FileRunObserver, Redactor } from "../packages/observability/src/index.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";

const evidenceDirectory = resolve("evidence/live-run");
const sensitiveValues = ["12345", "67890"];
const redact = (value: string) => sensitiveValues.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);

if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is missing from .env");

await mkdir(evidenceDirectory, { recursive: true });
const server = await startTargetServer(4173);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
const origin = `http://127.0.0.1:${address.port}`;

const provider = new AnthropicDecisionProvider({ maxOutputTokens: 1_500 });
const discoverySurface = await PlaywrightWebSurface.launch();

try {
  const discovery = await new DiscoveryRunner(discoverySurface, provider).run({
    goal: "Look up member ${inputs.member_id} and return their current savings balance",
    capability: {
      name: "read_savings_balance",
      version: "1.0.0",
      description: "Find a member and return the current savings balance",
      target: { surface: "web", app: "northstar_core", entrypoint: `${origin}/members` }
    },
    contract: {
      inputs: [{ name: "member_id", type: "string", description: "Member number", required: true, sensitive: true }],
      outputs: [{ name: "current_balance", type: "string", description: "Displayed savings balance", pattern: "^\\$[0-9,]+\\.[0-9]{2}$" }]
    },
    inputs: { member_id: "12345" },
    maxSteps: 8
  });

  const serializedArtifact = JSON.stringify(discovery.artifact);
  if (sensitiveValues.some((value) => serializedArtifact.includes(value))) {
    throw new Error("Generated artifact contains a runtime input; refusing to persist unparameterized evidence");
  }

  await discoverySurface.screenshot(resolve(evidenceDirectory, "discovery-final.png"));
  await writeFile(resolve(evidenceDirectory, "artifact.json"), `${JSON.stringify(discovery.artifact, null, 2)}\n`);
  const events = discovery.turns.map((turn) => redact(JSON.stringify({
    runId: discovery.runId,
    phase: "discovery",
    step: turn.step,
    url: turn.observation.url,
    action: turn.action,
    error: turn.error
  }))).join("\n");
  await writeFile(resolve(evidenceDirectory, "discovery.jsonl"), `${events}\n`);
  await writeFile(resolve(evidenceDirectory, "usage.json"), `${JSON.stringify({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
    ...provider.usage()
  }, null, 2)}\n`);

  const replaySurface = await PlaywrightWebSurface.launch();
  try {
    const replayObserver = new FileRunObserver(
      evidenceDirectory,
      new Redactor(sensitiveValues),
      "replay.jsonl"
    );
    const replay = await new ReplayEngine(replaySurface, undefined, undefined, replayObserver)
      .run(discovery.artifact, { member_id: "67890" });
    if (replay.status !== "success") throw new Error(`Replay failed: ${JSON.stringify(replay)}`);
    await replaySurface.screenshot(resolve(evidenceDirectory, "replay-final.png"));
    await writeFile(resolve(evidenceDirectory, "replay.json"), `${redact(JSON.stringify(replay, null, 2))}\n`);
  } finally {
    await replaySurface.close();
  }

  console.log(`Live discovery and deterministic replay evidence written to ${evidenceDirectory}`);
  console.log(`Claude usage: ${JSON.stringify(provider.usage())}`);
} finally {
  await discoverySurface.close();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
