import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { startTargetServer } from "../apps/target/src/server.js";
import { PlaywrightWebSurface, TargetResolutionError } from "../packages/surface/src/index.js";

let server: Server;
let origin: string;

before(async () => {
  server = await startTargetServer(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

test("surface observes and completes the member balance workflow", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    await surface.navigate(origin);
    const initial = await surface.observe();
    assert.match(initial.visibleText, /Member Service/);
    assert.ok(initial.controls.some((control) => control.tag === "input"));

    await surface.fill({
      description: "Member Number input",
      locators: [{ strategy: "label", value: "Member Number", exact: true }],
      requireUnique: true
    }, "12345");
    await surface.click({
      description: "Search button",
      locators: [{ strategy: "role", role: "button", value: "Search", exact: true }],
      requireUnique: true
    });
    await surface.click({
      description: "Savings link",
      locators: [{ strategy: "role", role: "link", value: "View Account", exact: true }],
      requireUnique: true
    });
    const balance = await surface.extractText({
      description: "Current balance",
      locators: [{ strategy: "css", value: "[data-field=current-balance]", exact: true }],
      requireUnique: true
    });
    assert.equal(balance, "$4,281.36");
    assert.deepEqual((await surface.observe()).dataFields, [{
      name: "current-balance", text: "$4,281.36", selector: "[data-field=\"current-balance\"]"
    }]);
  } finally {
    await surface.close();
  }
});

test("surface reports every failed locator candidate", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    await surface.navigate(origin);
    await assert.rejects(
      surface.click({
        description: "Missing control",
        locators: [
          { strategy: "role", role: "button", value: "Continue", exact: true },
          { strategy: "text", value: "Proceed", exact: true }
        ],
        requireUnique: true
      }, 100),
      (error) => error instanceof TargetResolutionError && error.attempts.length === 2
    );
  } finally {
    await surface.close();
  }
});

test("visibility checks reject hidden DOM matches", async () => {
  const surface = await PlaywrightWebSurface.launch();
  try {
    await surface.navigate(origin);
    assert.equal(await surface.isVisible({
      description: "Hidden document metadata",
      locators: [{ strategy: "css", value: "head", exact: true }],
      requireUnique: true
    }, 20), false);
  } finally {
    await surface.close();
  }
});
