import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { startTargetServer } from "../apps/target/src/server.js";

let server: Server;
let origin: string;

before(async () => {
  server = await startTargetServer(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test("member lookup reaches the savings balance", async () => {
  const result = await fetch(`${origin}/members/search?memberId=12345`);
  assert.equal(result.status, 200);
  assert.match(await result.text(), /\/members\/12345\/savings/);
  const savings = await fetch(`${origin}/members/12345/savings`);
  assert.match(await savings.text(), /\$4,281\.36/);
});

test("unknown member is a distinct business outcome", async () => {
  const result = await fetch(`${origin}/members/search?memberId=00000`);
  assert.equal(result.status, 404);
  assert.match(await result.text(), /No member found/);
});

test("permission and timeout scenarios are injectable", async () => {
  assert.equal((await fetch(`${origin}/members/search?memberId=12345&scenario=denied`)).status, 403);
  const timeout = await fetch(`${origin}/members/search?memberId=12345&scenario=timeout`);
  assert.equal(timeout.status, 503);
  assert.equal(timeout.headers.get("retry-after"), "1");
});

test("transient scenario fails once and then recovers", async () => {
  const first = await fetch(`${origin}/members/search?memberId=67890&scenario=transient`);
  assert.equal(first.status, 503);
  const second = await fetch(`${origin}/members/search?memberId=67890&scenario=transient`);
  assert.equal(second.status, 200);
  assert.match(await second.text(), /Member Summary/);
});
