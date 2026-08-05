import { defineAgent } from "eve";

import { agentModel } from "../../lib/model";

export default defineAgent({
  description:
    "Researches real scheduled sporting events in depth. Give it a sport and a time window, or a specific match, and it discovers fixtures, gathers evidence from free public sources, argues both sides, and returns calibrated probability estimates for the markets it thinks are mispriced. Use it before any bet is planned, and again to refresh a draft before execution.",
  ...agentModel("RESEARCH"),
  reasoning: "high",
});
