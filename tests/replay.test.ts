import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { startTargetServer } from "../apps/target/src/server.js";
import { ReplayEngine } from "../packages/replay/src/index.js";
import { PlaywrightWebSurface } from "../packages/surface/src/index.js";

let server: Server;
let origin: string;
let artifact: Record<string, any>;

before(async () => {
  server = await startTargetServer(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
  artifact = JSON.parse(await readFile(new URL("../capabilities/read_savings_balance.json", import.meta.url), "utf8"));
  artifact.capability.target.entrypoint = `${origin}/members`;
});

after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test("replays a saved capability with no model in the loop", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(artifact, { member_id: "12345" });
    assert.equal(result.status, "success");
    if (result.status === "success") assert.deepEqual(result.outputs, { current_balance: "$4,281.36" });
  } finally {
    await surface.close();
  }
});

test("rejects invalid invocation inputs before touching the surface", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    const result = await new ReplayEngine(surface).run(artifact, { member_id: 12345 });
    assert.equal(result.status, "failure");
    if (result.status === "failure") assert.equal(result.error.code, "invalid_inputs");
    assert.equal((await surface.observe()).url, "about:blank");
  } finally {
    await surface.close();
  }
});
