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

    // A sandbox is keyed to a durable session and lives as long as the session
    // does, so this is also the ceiling on how long a VM can sit on the host.
    // eve's default is 30 days, which on a server running cycles every day
    // means a month of machines nobody will use again.
    //
    // A day is far longer than any cycle needs. Nothing of record is lost when
    // a session ends: the spreadsheet is the state, and `/workspace` only ever
    // holds a working notebook.
    sessionTimeoutMs: 24 * 60 * 60_000,
  },

  experimental: {
    // Reuse each specialist's session across delegations instead of spawning a
    // one-shot child every time.
    //
    // Without this a single cycle asks `execution` for a balance, then for
    // prices, then to place a bet — three delegations, three sessions, and on
    // the microsandbox backend three separate VMs, each held for the session
    // lifetime above. Days of that is how a host fills up.
    //
    // Reuse is also the better behaviour: `execution` keeps its browser and its
    // placement journal between delegations rather than logging in from scratch
    // each time, and the notebook agents keep the notes they were designed
    // around.
    subagentPersistentSessions: true,
  },
});
