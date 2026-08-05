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
  judge: {
    model: modelFor("JUDGE"),

    // A grader is asked for a verdict through a forced tool call, and DeepSeek
    // refuses a forced `tool_choice` while it is reasoning: "Thinking mode does
    // not support this tool_choice". Grading needs a decision, not deliberation,
    // so turning thinking off is the right shape for this call anyway.
    //
    // Provider options are namespaced by provider, so this key is simply
    // ignored when the judge is an Anthropic, OpenAI or Google model.
    modelOptions: { providerOptions: { deepseek: { thinking: { type: "disabled" } } } },
  },

  // One at a time. An eval here is not a unit test: it drives five subagents,
  // each with its own sandbox, and the execution one boots a VM. Running two in
  // parallel on a developer machine makes both slower than running them in turn.
  maxConcurrency: 1,

  // A whole cycle — research, planning, review, placement, monitoring — through
  // a mid-tier model. Five minutes only ever measured how far it had got.
  timeoutMs: 1_200_000,
});
