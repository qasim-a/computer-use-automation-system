import type { DiscoveryAction, DiscoveryRequest } from "./discovery.js";
import { targets } from "./discovery.js";

export function memberBalanceActions(): DiscoveryAction[] {
  return [
    { id: "open_members", action: "navigate", description: "Open member search", risk: "read_only", url: "${target.entrypoint}", timeoutMs: 10_000 },
    { id: "enter_member_id", action: "fill", description: "Enter member number", risk: "reversible", target: targets.memberNumber, value: "${inputs.member_id}", timeoutMs: 10_000 },
    { id: "search_member", action: "click", description: "Search for member", risk: "reversible", target: targets.search, timeoutMs: 10_000 },
    { id: "open_savings", action: "click", description: "Open savings account", risk: "read_only", target: targets.savingsLink, timeoutMs: 10_000 },
    { id: "read_balance", action: "extract", description: "Read balance", risk: "read_only", target: targets.balance, output: "current_balance", timeoutMs: 10_000 },
    { action: "finish", description: "Savings balance was extracted", success: { kind: "visible", target: targets.savingsTable } }
  ];
}

export function memberBalanceRequest(entrypoint: string, memberId: string): DiscoveryRequest {
  return {
    goal: "Look up member ${inputs.member_id} and return their current savings balance",
    capability: {
      name: "read_savings_balance",
      version: "1.0.0",
      description: "Find a member and return the current savings balance",
      target: { surface: "web", app: "northstar_core", entrypoint }
    },
    contract: {
      inputs: [{ name: "member_id", type: "string", description: "Member number", required: true, sensitive: true }],
      outputs: [{
        name: "current_balance", type: "string", description: "Displayed savings balance",
        pattern: "^\\$[0-9,]+\\.[0-9]{2}$"
      }]
    },
    inputs: { member_id: memberId },
    maxSteps: 8
  };
}
