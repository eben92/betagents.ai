import { defineAgent } from "eve";

import { agentModel } from "../../lib/model";

export default defineAgent({
  description:
    "Chooses which researched opportunities deserve real money, sizes each stake against the bankroll rules, and drafts the bet. Give it the shortlist ids to consider. It returns the drafts it created, or nothing when no opportunity is worth backing.",
  ...agentModel("PLANNER"),
  reasoning: "high",
});
