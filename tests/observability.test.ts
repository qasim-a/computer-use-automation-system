import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Surface } from "../packages/surface/src/index.js";
import { FileRunObserver, MemoryRunObserver, Redactor } from "../packages/observability/src/index.js";

test("recursively redacts configured values and sensitive keys", () => {
  const redactor = new Redactor(["12345", "example-api-credential"]);
  assert.deepEqual(redactor.redact({
    memberId: "12345",
    authorization: "unlisted credential",
    url: "http://localhost/members/12345",
    nested: { api_key: "example-api-credential", note: "member 12345" }
  }), {
    memberId: "[REDACTED]",
    authorization: "[REDACTED]",
    url: "http://localhost/members/[REDACTED]",
    nested: { api_key: "[REDACTED]", note: "member [REDACTED]" }
  });
});

test("memory observer stores structured redacted events", async () => {
  const observer = new MemoryRunObserver(new Redactor(["12345"]));
  await observer.record({
    runId: "run-1", phase: "replay", type: "step_started", stepId: "lookup",
    details: { url: "http://localhost/members/12345" }
  });
  assert.equal(observer.events.length, 1);
  assert.deepEqual(observer.events[0]?.details, { url: "http://localhost/members/[REDACTED]" });
});

test("file observer writes redacted JSONL and requests a failure screenshot", async () => {
  const directory = `/tmp/cuas-observer-${randomUUID()}`;
  let screenshotPath = "";
  const surface: Surface = {
    navigate: async () => {},
    observe: async () => ({ url: "about:blank", title: "", visibleText: "", controls: [], dataFields: [] }),
    click: async () => {}, fill: async () => {}, extractText: async () => "", close: async () => {},
    screenshot: async (path) => { screenshotPath = path; }
  };
  const observer = new FileRunObserver(directory, new Redactor(["12345"]));
  await observer.record({ runId: "run-1", phase: "replay", type: "run_failed", details: { member_id: "12345" } });
  const evidence = await observer.captureFailure(surface, "run-1", "search/member");
  assert.equal(evidence, screenshotPath);
  assert.match(screenshotPath, /run-1-search_member-failure\.png$/);
  assert.doesNotMatch(await readFile(`${directory}/events.jsonl`, "utf8"), /12345/);
});
