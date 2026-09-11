import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs } from "../scripts/cli.js";

test("parses reviewer CLI commands and options", () => {
  assert.deepEqual(parseCliArgs(["discover", "--mode", "scripted", "--member-id", "12345"]), {
    command: "discover",
    options: { mode: "scripted", "member-id": "12345" }
  });
});

test("rejects unknown commands and incomplete options", () => {
  assert.throws(() => parseCliArgs(["unknown"]), /Usage/);
  assert.throws(() => parseCliArgs(["replay", "--artifact"]), /Invalid option/);
});
