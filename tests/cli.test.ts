import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCliArgs, runCli } from "../scripts/cli.js";

test("parses reviewer CLI commands and options", () => {
  assert.deepEqual(parseCliArgs(["discover", "--mode", "scripted", "--member-id", "12345"]), {
    command: "discover",
    options: { mode: "scripted", "member-id": "12345" }
  });
});

test("parses artifact qualification options", () => {
  assert.deepEqual(parseCliArgs(["qualify", "--runs", "3", "--reviewer", "qasim@example.test"]), {
    command: "qualify", options: { runs: "3", reviewer: "qasim@example.test" }
  });
});

test("runs a reviewer-facing handoff demo and redacts its sensitive output log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "automation-handoff-"));
  const output = join(directory, "result.json");
  const result = await runCli([
    "handoff", "--port", "0", "--member-id", "67890", "--operator", "reviewer", "--output", output
  ]) as {
    status: string;
    outputs: { current_balance: string };
    intervention: { requestId: string; stepId: string; failureCode: string; operator: string; resumed: boolean };
  };
  assert.equal(result.status, "success");
  assert.equal(result.outputs.current_balance, "$912.04");
  assert.equal(result.intervention.stepId, "search_member");
  assert.equal(result.intervention.failureCode, "timeout");
  assert.equal(result.intervention.operator, "reviewer");
  assert.equal(result.intervention.resumed, true);
  const events = await readFile(join(directory, "result-run", "events.jsonl"), "utf8");
  assert.doesNotMatch(events, /\$912\.04/);
  assert.match(events, /"current_balance":"\[REDACTED\]"/);
});

test("rejects unknown commands and incomplete options", () => {
  assert.throws(() => parseCliArgs(["unknown"]), /Usage/);
  assert.throws(() => parseCliArgs(["replay", "--artifact"]), /Invalid option/);
});
