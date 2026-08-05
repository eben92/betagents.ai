import { defineAgent } from "eve";

import { agentModel } from "./lib/model";

/**
 * The orchestrator. It reads state, works the controls, and delegates every
 * piece of real work to one of the five specialists in `subagents/`.
 *
 * Its model, like every agent's, comes from the environment — see
 * `lib/model.ts`. Any provider works, and they can differ per agent.
 */
export default defineAgent({
  ...agentModel("CONTROL"),
  limits: {
    // A control conversation should never grow large. If it does, something is
    // looping, and the budget should stop it.
    maxOutputTokensPerSession: 200_000,
  },
});
