import { defineEvalConfig } from "eve/evals";

import { modelFor } from "../agent/lib/model";

/**
 * Evals cover the layer the offline tests cannot: whether the orchestrator and
 * its subagents actually make the right calls in the right order.
 *
 * They need a real provider key for whatever `MODEL_*` names, and run against
 * the simulated bookmaker, so nothing here can move real money.
 */
export default defineEvalConfig({
  judge: { model: modelFor("JUDGE") },
  maxConcurrency: 2,
  timeoutMs: 300_000,
});
