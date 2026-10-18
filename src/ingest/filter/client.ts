import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../lib/log";
import { OUTPUT_CONTRACT, RUBRIC_PREAMBLE } from "./schema";

const log = logger("filter:client");

/** claude-opus-5-5 list prices, $ per million tokens. */
const PRICING = { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 };

/**
 * Below this many tokens the API silently declines to cache the prefix. Setting
 * cache_control anyway is harmless but leaves cache_read at 0 forever while you
 * believe caching is on, so we check and say so instead.
 */
const CACHE_MIN_TOKENS = 1024;

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export function estimateCost(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): number {
  const m = 1e-6;
  return (
    (usage.input_tokens ?? 0) * PRICING.input * m +
    (usage.output_tokens ?? 0) * PRICING.output * m +
    (usage.cache_read_input_tokens ?? 0) * PRICING.cacheRead * m +
    (usage.cache_creation_input_tokens ?? 0) * PRICING.cacheWrite * m
  );
}

export type SystemPlan = {
  blocks: Anthropic.TextBlockParam[];
  cached: boolean;
  tokens: number;
};

/**
 * Builds the system prefix once per run and decides whether caching can engage.
 * Render order is tools -> system -> messages, so the volatile video batch sits
 * entirely after the breakpoint and never invalidates the prefix.
 */
export async function planSystem(model: string, userPrompt: string): Promise<SystemPlan> {
  const texts = [RUBRIC_PREAMBLE, userPrompt, OUTPUT_CONTRACT];
  const probe: Anthropic.TextBlockParam[] = texts.map((text) => ({ type: "text", text }));

  let tokens = 0;
  try {
    const counted = await anthropic().messages.countTokens({
      model,
      system: probe,
      messages: [{ role: "user", content: "[]" }],
    });
    tokens = counted.input_tokens;
  } catch (err) {
    log.warn(`countTokens failed (${(err as Error).message}); assuming caching is unavailable`);
  }

  const cached = tokens >= CACHE_MIN_TOKENS;
  if (!cached) {
    log.info(
      `caching disabled: system prefix is ${tokens} tokens (< ${CACHE_MIN_TOKENS}). ` +
        "Lengthen filter-prompt.md to engage prompt caching.",
    );
  } else {
    log.info(`system prefix ${tokens} tokens — caching enabled`);
  }

  const blocks = probe.map((b, i) =>
    cached && i === probe.length - 1 ? { ...b, cache_control: { type: "ephemeral" as const } } : b,
  );
  return { blocks, cached, tokens };
}
