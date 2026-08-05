import { defineAgent } from "eve";

import { agentModel } from "../../lib/model";

export default defineAgent({
  description:
    "Interacts with the betting operator's website through a browser: signs in, reads the balance, finds an approved event and market, and places an approved bet. Give it an approval id to place, or ask it for the balance or the current bet history. It never decides what to bet, only carries out an approved instruction.",
  ...agentModel("EXECUTION"),
  reasoning: "medium",
});
