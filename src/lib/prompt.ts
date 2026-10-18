import crypto from "node:crypto";
import fs from "node:fs";
import { PROMPT_EXAMPLE_PATH, PROMPT_PATH } from "./env";
import { getDb } from "./db";

export const FILTER_MODEL = "claude-opus-5-5";

/**
 * Bump whenever the per-video payload sent to Claude or the output schema
 * changes. Old verdicts were produced from different evidence and must not be
 * reused, which a prompt-text-only hash would do silently.
 */
export const PIPELINE_VERSION = 1;

/** Normalize before hashing so trailing-whitespace churn can't trigger a re-filter. */
export function normalizePrompt(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function hashPrompt(text: string, model = FILTER_MODEL, pipelineVersion = PIPELINE_VERSION): string {
  return crypto
    .createHash("sha256")
    .update(`${pipelineVersion}\u0000${model}\u0000${normalizePrompt(text)}`)
    .digest("hex")
    .slice(0, 16);
}

export type ActivePrompt = { hash: string; text: string; model: string; pipelineVersion: number };

/** Reads filter-prompt.md, seeding it from the committed example on first run. */
export function readPromptFile(): string {
  if (!fs.existsSync(PROMPT_PATH)) {
    if (!fs.existsSync(PROMPT_EXAMPLE_PATH)) {
      throw new Error(`No filter prompt found at ${PROMPT_PATH} and no example to seed it from.`);
    }
    fs.copyFileSync(PROMPT_EXAMPLE_PATH, PROMPT_PATH);
  }
  const text = normalizePrompt(fs.readFileSync(PROMPT_PATH, "utf8"));
  if (!text) throw new Error(`${PROMPT_PATH} is empty — write the filter you want applied.`);
  return text;
}

/** Resolves the current prompt and records it, so verdicts can reference the hash. */
export function getActivePrompt(): ActivePrompt {
  const text = readPromptFile();
  const hash = hashPrompt(text);
  getDb()
    .prepare(
      `INSERT INTO filter_prompts (hash, prompt_text, model, pipeline_version)
       VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
    )
    .run(hash, text, FILTER_MODEL, PIPELINE_VERSION);
  return { hash, text, model: FILTER_MODEL, pipelineVersion: PIPELINE_VERSION };
}
