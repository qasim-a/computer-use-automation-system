import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming, Tool } from "@anthropic-ai/sdk/resources/messages";
import { discoveryActionSchema, type DecisionContext, type DecisionProvider, type DiscoveryAction } from "./discovery.js";

type MessageResponse = {
  content: Array<{ type: string; name?: string; input?: unknown }>;
  usage: { input_tokens: number; output_tokens: number };
};

export interface AnthropicMessageClient {
  messages: {
    create(parameters: MessageCreateParamsNonStreaming): Promise<MessageResponse>;
  };
}

export type AnthropicProviderOptions = {
  apiKey?: string;
  model?: string;
  maxOutputTokens?: number;
  maxObservationChars?: number;
  client?: AnthropicMessageClient;
};

export type ModelUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

const decisionTool = {
  name: "choose_ui_action",
  description: "Choose exactly one safe next UI action based only on the current observation.",
  input_schema: {
    type: "object",
    properties: {
      action: { enum: ["navigate", "click", "fill", "extract", "wait", "finish"] },
      id: { type: "string", description: "Stable snake_case step ID; omit only for finish" },
      description: { type: "string" },
      url: { type: "string" },
      value: { type: "string" },
      output: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 60000 },
      target: { "$ref": "#/definitions/target" },
      checkpoint: { "$ref": "#/definitions/checkpoint" },
      for: { "$ref": "#/definitions/checkpoint" },
      success: { "$ref": "#/definitions/checkpoint" }
    },
    required: ["action", "description"],
    definitions: {
      locator: {
        type: "object",
        properties: {
          strategy: { enum: ["role", "label", "text", "css"] },
          value: { type: "string" },
          role: { type: "string" },
          exact: { type: "boolean" }
        },
        required: ["strategy", "value", "exact"]
      },
      target: {
        type: "object",
        properties: {
          description: { type: "string" },
          locators: { type: "array", minItems: 1, items: { "$ref": "#/definitions/locator" } },
          requireUnique: { type: "boolean" }
        },
        required: ["description", "locators", "requireUnique"]
      },
      checkpoint: {
        type: "object",
        properties: {
          kind: { enum: ["url", "visible", "text"] },
          matches: { type: "string" },
          target: { "$ref": "#/definitions/target" }
        },
        required: ["kind"]
      }
    }
  }
} satisfies Tool;

export class AnthropicDecisionProvider implements DecisionProvider {
  private readonly client: AnthropicMessageClient;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly maxObservationChars: number;
  private readonly totals: ModelUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    this.maxOutputTokens = options.maxOutputTokens ?? 1_500;
    this.maxObservationChars = options.maxObservationChars ?? 12_000;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  usage(): Readonly<ModelUsage> {
    return { ...this.totals };
  }

  async decide(context: DecisionContext): Promise<DiscoveryAction> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxOutputTokens,
      system: systemPrompt,
      tool_choice: { type: "tool", name: decisionTool.name },
      tools: [decisionTool],
      messages: [{ role: "user", content: observationPrompt(context, this.maxObservationChars) }]
    });
    this.totals.requests += 1;
    this.totals.inputTokens += response.usage.input_tokens;
    this.totals.outputTokens += response.usage.output_tokens;

    const call = response.content.find((block) => block.type === "tool_use" && block.name === decisionTool.name);
    if (!call) throw new Error("Claude did not return a choose_ui_action tool call");
    const parsed = discoveryActionSchema.safeParse(call.input);
    if (!parsed.success) throw new Error(`Claude returned an invalid action: ${parsed.error.message}`);
    return parsed.data;
  }
}

const systemPrompt = `You discover reusable UI capabilities. Choose one action per turn.
Use only controls supported by the observation. Prefer role, label, and visible-text locators over CSS.
Use fixed, ordered locator fallbacks and require unique matches. Never invent test IDs.
For this capability, navigate with \${target.entrypoint}, fill the member value with \${inputs.member_id},
and extract the result into current_balance. Finish only after the balance is visible and extracted.
Return snake_case IDs and a 10000ms timeout for every recorded step.`;

function observationPrompt(context: DecisionContext, limit: number): string {
  const priorActions = context.history.map((turn) => ({ step: turn.step, action: turn.action.action }));
  const observation = {
    url: context.observation.url,
    title: context.observation.title,
    visibleText: context.observation.visibleText.slice(0, limit),
    controls: context.observation.controls
  };
  return JSON.stringify({ goal: context.goal, step: context.step, priorActions, observation });
}
