import type { DecisionContext, DecisionProvider, DiscoveryAction } from "./discovery.js";

export class ScriptedDecisionProvider implements DecisionProvider {
  private cursor = 0;

  constructor(private readonly actions: readonly DiscoveryAction[]) {}

  async decide(_context: DecisionContext): Promise<DiscoveryAction> {
    const action = this.actions[this.cursor];
    if (!action) throw new Error("Scripted decision provider ran out of actions before finish");
    this.cursor += 1;
    return structuredClone(action);
  }
}
