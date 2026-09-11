import "dotenv/config";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startTargetServer } from "../apps/target/src/server.js";
import {
  AnthropicDecisionProvider,
  DiscoveryRunner,
  ScriptedDecisionProvider,
  memberBalanceActions,
  memberBalanceRequest
} from "../packages/discovery/src/index.js";
import { FileRunObserver, Redactor } from "../packages/observability/src/index.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";

type CliOptions = Record<string, string>;

export function parseCliArgs(arguments_: string[]): { command: string; options: CliOptions } {
  const [command, ...rest] = arguments_;
  if (!command || !["discover", "replay", "exceptional"].includes(command)) {
    throw new Error("Usage: cli.ts <discover|replay|exceptional> [--key value]");
  }
  const options: CliOptions = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid option near ${key ?? "end"}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

export async function runCli(arguments_: string[]): Promise<unknown> {
  const { command, options } = parseCliArgs(arguments_);
  const port = Number(options.port ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be a valid TCP port");
  const server = await startTargetServer(port);
  try {
    if (command === "discover") return await discover(options, port);
    if (command === "replay") return await replay(options, port, command);
    return await replay({
      ...options,
      artifact: options.artifact ?? "capabilities/read_savings_balance.json",
      "member-id": "00000",
      output: options.output ?? "evidence/exceptional-run/result.json"
    }, port, command);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

async function discover(options: CliOptions, port: number) {
  const mode = options.mode ?? "scripted";
  if (mode !== "scripted" && mode !== "live") throw new Error("--mode must be scripted or live");
  if (mode === "live" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is missing from .env");
  const memberId = options["member-id"] ?? "12345";
  const output = resolve(options.output ?? "output/discovered-capability.json");
  const evidenceDirectory = `${output.slice(0, -5)}-run`;
  const observer = new FileRunObserver(evidenceDirectory, new Redactor([memberId]));
  const decisions = mode === "live"
    ? new AnthropicDecisionProvider({ maxOutputTokens: 1_500 })
    : new ScriptedDecisionProvider(memberBalanceActions());
  const surface = await PlaywrightWebSurface.launch({ headless: options.headless !== "false" });
  try {
    const result = await new DiscoveryRunner(surface, decisions, undefined, observer).run(
      memberBalanceRequest(`http://127.0.0.1:${port}/members`, memberId)
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result.artifact, null, 2)}\n`);
    await surface.screenshot(resolve(evidenceDirectory, "final.png"));
    return { status: "success", mode, artifact: output, runId: result.runId, outputs: result.outputs };
  } finally {
    await surface.close();
  }
}

async function replay(options: CliOptions, port: number, command: string) {
  const artifactPath = resolve(options.artifact ?? "capabilities/read_savings_balance.json");
  const memberId = options["member-id"] ?? "67890";
  const output = resolve(options.output ?? `output/${command}-result.json`);
  const evidenceDirectory = `${output.slice(0, -5)}-run`;
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  if (artifact?.capability?.target) artifact.capability.target.entrypoint = `http://127.0.0.1:${port}/members`;
  const observer = new FileRunObserver(evidenceDirectory, new Redactor([memberId]));
  const surface = await PlaywrightWebSurface.launch({ headless: options.headless !== "false" });
  try {
    const result = await new ReplayEngine(surface, undefined, undefined, observer).run(artifact, { member_id: memberId });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    await surface.screenshot(resolve(evidenceDirectory, "final.png"));
    return { ...result, result: output };
  } finally {
    await surface.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
