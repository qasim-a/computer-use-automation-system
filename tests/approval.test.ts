import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  ApprovalRejectedError,
  approveArtifact,
  assessStability,
  verifyArtifactApproval
} from "../packages/approval/src/index.js";
import type { ReplayResult } from "../packages/contracts/src/index.js";

const success = (balance: string): ReplayResult => ({
  runId: crypto.randomUUID(), capabilityName: "read_savings_balance", capabilityVersion: "1.0.0",
  durationMs: 10, status: "success", outputs: { current_balance: balance }
});

test("approves stable artifacts and detects post-approval changes", async () => {
  const artifact = JSON.parse(await readFile(new URL("../capabilities/read_savings_balance.json", import.meta.url), "utf8"));
  const stability = assessStability([success("$912.04"), success("$912.04"), success("$912.04")]);
  const approved = approveArtifact(artifact, "qasim@example.test", stability);
  assert.equal(approved.lifecycle, "approved");
  assert.equal(approved.approval?.stability.successRate, 1);
  assert.equal(verifyArtifactApproval(approved), undefined);

  approved.steps[0]!.description = "Changed after review";
  assert.match(verifyArtifactApproval(approved) ?? "", /changed after approval/);

  const metadataChanged = approveArtifact(artifact, "qasim@example.test", stability);
  metadataChanged.approval!.approvedBy = "different-reviewer@example.test";
  assert.match(verifyArtifactApproval(metadataChanged) ?? "", /changed after approval/);
});

test("rejects insufficient or inconsistent replay evidence", async () => {
  const artifact = JSON.parse(await readFile(new URL("../capabilities/read_savings_balance.json", import.meta.url), "utf8"));
  assert.throws(
    () => approveArtifact(artifact, "qasim@example.test", assessStability([success("$1.00")])),
    ApprovalRejectedError
  );
  assert.throws(
    () => approveArtifact(artifact, "qasim@example.test", assessStability([
      success("$1.00"), success("$2.00"), success("$1.00")
    ])),
    /inconsistent/
  );
});
