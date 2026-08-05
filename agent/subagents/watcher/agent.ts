import { defineAgent } from "eve";

import { agentModel } from "../../lib/model";

export default defineAgent({
  description:
    "Monitors matches the system has open bets on and settles them when they finish. Returns which bets moved, which settled, and the profit or loss. Ask it to run a monitoring pass; it reports only what is worth knowing.",
  ...agentModel("WATCHER"),
});
