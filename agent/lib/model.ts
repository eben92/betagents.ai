/**
 * Per-agent model selection, from the environment, for any provider.
 *
 * Every agent's model is one variable in the form `provider:model-id`:
 *
 *   MODEL_RESEARCH=anthropic:claude-sonnet-4-5
 *   MODEL_PLANNER=deepseek:deepseek-reasoner
 *   MODEL_WATCHER=google:gemini-2.0-flash
 *
 * Four providers are wired directly. Anything else is treated as an
 * OpenAI-compatible endpoint configured by two more variables, which is how
 * Kimi, Groq, OpenRouter, Together, Fireworks or a self-hosted vLLM are reached
 * without touching this file:
 *
 *   MODEL_REVIEWER=kimi:kimi-k2-0905-preview
 *   KIMI_BASE_URL=https://api.moonshot.ai/v1
 *   KIMI_API_KEY=...
 *
 * Nothing routes through a hosted gateway. Each provider is called directly
 * with its own key, so mixing vendors across agents costs nothing but the keys.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * A resolved model client. `LanguageModel` also admits a bare gateway id
 * string; this module never returns one, because nothing here routes through a
 * gateway.
 */
export type ResolvedModel = Exclude<LanguageModel, string>;

/** Which agent a model is for. Each maps to `MODEL_<NAME>`. */
export type AgentName =
  | "CONTROL"
  | "RESEARCH"
  | "PLANNER"
  | "REVIEWER"
  | "EXECUTION"
  | "WATCHER"
  /** Grades `npm run eval`; not part of the running system. */
  | "JUDGE";

/**
 * Used when `MODEL_<AGENT>` is unset. These are starting points, not
 * recommendations — the point of this module is that you pick.
 */
const DEFAULTS: Record<AgentName, string> = {
  CONTROL: "anthropic:claude-sonnet-4-5",
  RESEARCH: "anthropic:claude-sonnet-4-5",
  PLANNER: "anthropic:claude-opus-4-5",
  REVIEWER: "anthropic:claude-opus-4-5",
  EXECUTION: "anthropic:claude-sonnet-4-5",
  WATCHER: "anthropic:claude-haiku-4-5",
  JUDGE: "anthropic:claude-sonnet-4-5",
};

/** Providers with a first-class AI SDK package and a conventional key name. */
const DIRECT: Record<string, { key: string; create: (apiKey: string) => (id: string) => ResolvedModel }> = {
  anthropic: {
    key: "ANTHROPIC_API_KEY",
    create: (apiKey) => createAnthropic({ apiKey }),
  },
  openai: {
    key: "OPENAI_API_KEY",
    create: (apiKey) => createOpenAI({ apiKey }),
  },
  google: {
    key: "GOOGLE_GENERATIVE_AI_API_KEY",
    create: (apiKey) => createGoogleGenerativeAI({ apiKey }),
  },
  deepseek: {
    key: "DEEPSEEK_API_KEY",
    create: (apiKey) => createDeepSeek({ apiKey }),
  },
};

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

function envKey(provider: string, suffix: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`;
}

/**
 * Splits `provider:model-id` into its parts.
 *
 * `provider/model-id` is accepted too, because that is how model ids are
 * written nearly everywhere else and typing a slash here is the obvious
 * mistake. A colon wins when both appear, so an OpenRouter-style id keeps its
 * slash: `openrouter:qwen/qwen-2.5-72b-instruct`.
 */
function splitSpec(spec: string): { provider: string; modelId: string } {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(":");
  const separator = colon > 0 ? colon : trimmed.indexOf("/");

  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new ModelConfigError(
      `Model "${spec}" must name a provider and a model, as provider:model-id — for example anthropic:claude-sonnet-4-5 or deepseek:deepseek-chat.`,
    );
  }

  return {
    provider: trimmed.slice(0, separator).toLowerCase(),
    modelId: trimmed.slice(separator + 1).trim(),
  };
}

/**
 * Resolves one `provider:model-id` string to a live model.
 *
 * A missing API key is *not* fatal here. eve compiles every `agent.ts` at build
 * and discovery time, so throwing would make `eve info` and `eve build` require
 * production credentials. The call fails at request time instead, which is
 * where the framework already reports missing credentials.
 */
export function resolveModel(spec: string): ResolvedModel {
  const { provider, modelId } = splitSpec(spec);

  const direct = DIRECT[provider];
  if (direct) {
    return direct.create(process.env[direct.key]?.trim() ?? "")(modelId);
  }

  // Any other provider is an OpenAI-compatible endpoint described by env.
  const baseURL = process.env[envKey(provider, "BASE_URL")]?.trim();
  if (!baseURL) {
    throw new ModelConfigError(
      `Unknown model provider "${provider}". Either use one of ${Object.keys(DIRECT).join(", ")}, or set ${envKey(provider, "BASE_URL")} and ${envKey(provider, "API_KEY")} to reach it as an OpenAI-compatible endpoint.`,
    );
  }

  return createOpenAICompatible({
    name: provider,
    baseURL,
    apiKey: process.env[envKey(provider, "API_KEY")]?.trim(),
  })(modelId);
}

/** The model for one agent, from `MODEL_<AGENT>`. */
export function modelFor(agent: AgentName): ResolvedModel {
  return resolveModel(modelSpecFor(agent));
}

/** The raw spec for one agent, for reporting. Never resolves credentials. */
export function modelSpecFor(agent: AgentName): string {
  return process.env[`MODEL_${agent}`]?.trim() || DEFAULTS[agent];
}

/**
 * Context windows, in tokens, by model id.
 *
 * These must be declared. eve otherwise looks the model up in the Vercel AI
 * Gateway catalogue over the network, and **fails the build** for anything not
 * in it — which is every model reached through an OpenAI-compatible endpoint.
 * Declaring them here is what makes builds offline, deterministic and genuinely
 * gateway-free.
 *
 * Matched longest-prefix-first, so a family entry covers its variants. When a
 * model is missing, `MODEL_<AGENT>_CONTEXT` overrides it without a code change.
 *
 * Where a provider documents a range, the **lower** bound is used. Being wrong
 * low costs an early compaction; being wrong high overflows the window
 * mid-cycle, which is how an agent loses the bet it was placing.
 */
const CONTEXT_WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]> = [
  // DeepSeek's windows differ sharply by model: v4-flash is a long-context
  // model, while the v3-era chat and reasoner endpoints are not. Treating them
  // alike would either waste most of v4-flash or overflow the others.
  ["deepseek-v4-flash", 1_000_000],
  ["deepseek-v4", 128_000],
  ["deepseek-v3", 128_000],
  ["deepseek-reasoner", 128_000],
  ["deepseek-chat", 128_000],
  ["deepseek-r1", 128_000],
  ["deepseek", 64_000],

  ["claude-haiku-4-5", 200_000],
  ["claude-sonnet-4-5", 200_000],
  ["claude-opus-4-5", 200_000],
  ["claude-opus", 200_000],
  ["claude-sonnet", 200_000],
  ["claude-haiku", 200_000],
  ["claude", 200_000],

  ["gpt-5", 400_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["o3", 200_000],
  ["gpt", 128_000],

  ["gemini-2.5", 1_000_000],
  ["gemini-2.0", 1_000_000],
  ["gemini-1.5", 1_000_000],
  ["gemini", 1_000_000],

  ["kimi-k2", 256_000],
  ["kimi", 128_000],
  ["moonshot", 128_000],
  ["qwen", 128_000],
  ["llama", 128_000],
  ["mistral", 128_000],
  ["grok", 128_000],
];

/**
 * Assumed window for a model nobody has declared. Small on purpose: an unknown
 * model that is actually large only pays for early compaction, while an unknown
 * model that is actually small would otherwise overflow.
 */
const UNKNOWN_CONTEXT_WINDOW = 32_000;

export function contextWindowForSpec(spec: string): number {
  const modelId = spec.slice(spec.indexOf(":") + 1).toLowerCase();
  let best: { prefix: string; tokens: number } | null = null;

  for (const [prefix, tokens] of CONTEXT_WINDOWS) {
    if (!modelId.includes(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, tokens };
  }

  return best?.tokens ?? UNKNOWN_CONTEXT_WINDOW;
}

/** Context window for one agent, with `MODEL_<AGENT>_CONTEXT` taking priority. */
export function contextWindowFor(agent: AgentName): number {
  const override = Number(process.env[`MODEL_${agent}_CONTEXT`]?.trim());
  if (Number.isInteger(override) && override > 0) return override;
  return contextWindowForSpec(modelSpecFor(agent));
}

/**
 * When to start summarising older turns, as a fraction of the window.
 *
 * A small window needs to compact earlier, not at the same 90% a large one
 * tolerates: the fixed overhead of instructions, skills and tool schemas is the
 * same either way, so it eats a far larger share of a 64K window, and the
 * remaining headroom has to absorb a whole tool result at once.
 */
export function compactionThresholdFor(agent: AgentName): number {
  const tokens = contextWindowFor(agent);
  if (tokens <= 64_000) return 0.6;
  if (tokens <= 128_000) return 0.7;
  if (tokens <= 200_000) return 0.8;
  return 0.85;
}

/**
 * How many characters of a page, document or listing a tool should return.
 *
 * Scaled to the agent's window so one greedy tool result cannot consume a
 * small-context model's remaining headroom. Roughly four characters per token,
 * spending at most an eighth of the window on any single result.
 */
export function toolOutputBudgetFor(agent: AgentName): number {
  return Math.max(4_000, Math.floor((contextWindowFor(agent) / 8) * 4));
}

/** Everything `defineAgent` needs for one agent's model. Spread it in. */
export function agentModel(agent: AgentName): {
  model: ResolvedModel;
  modelContextWindowTokens: number;
  compaction: { thresholdPercent: number };
} {
  return {
    model: modelFor(agent),
    modelContextWindowTokens: contextWindowFor(agent),
    compaction: { thresholdPercent: compactionThresholdFor(agent) },
  };
}
