import assert from "node:assert/strict";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { test } from "node:test";
import {
  AnthropicDecisionProvider,
  type AnthropicMessageClient,
  type DecisionContext
} from "../packages/discovery/src/index.js";

const context: DecisionContext = {
  goal: "Look up member 12345 and return the savings balance",
  step: 0,
  history: [],
  observation: {
    url: "about:blank",
    title: "",
    visibleText: "",
    controls: []
  }
};

function clientReturning(input: unknown, captured?: MessageCreateParamsNonStreaming[]): AnthropicMessageClient {
  return {
    messages: {
      async create(parameters) {
        captured?.push(parameters);
        return {
          content: [{ type: "tool_use", name: "choose_ui_action", input }],
          usage: { input_tokens: 800, output_tokens: 40 }
        };
      }
    }
  };
}

test("requests and validates one structured Claude action", async () => {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const provider = new AnthropicDecisionProvider({
    model: "claude-sonnet-5",
    client: clientReturning({
      action: "navigate",
      id: "open_members",
      description: "Open member search",
      url: "${target.entrypoint}",
      timeoutMs: 10_000
    }, requests)
  });
  const action = await provider.decide(context);
  assert.equal(action.action, "navigate");
  assert.equal(requests[0]?.model, "claude-sonnet-5");
  assert.deepEqual(provider.usage(), { requests: 1, inputTokens: 800, outputTokens: 40 });
});

test("rejects malformed model actions at the provider boundary", async () => {
  const provider = new AnthropicDecisionProvider({ client: clientReturning({ action: "click", description: "Click nothing" }) });
  await assert.rejects(provider.decide(context), /invalid action/);
});

test("rejects responses without the required tool call", async () => {
  const client: AnthropicMessageClient = {
    messages: { async create() { return { content: [{ type: "text" }], usage: { input_tokens: 10, output_tokens: 2 } }; } }
  };
  await assert.rejects(new AnthropicDecisionProvider({ client }).decide(context), /did not return/);
});
