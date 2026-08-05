import { defineAgent } from "eve";

import { agentModel } from "../../lib/model";

export default defineAgent({
  description:
    "Independently reviews a drafted bet immediately before it is placed. Give it a draft id. It refreshes the research, re-checks the price and the fixture, then approves, cuts the stake, moves to a safer market, or rejects. Nothing reaches the operator without passing through it.",
  ...agentModel("REVIEWER"),
  reasoning: "high",
});
