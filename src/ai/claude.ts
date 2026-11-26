/**
 * src/ai/claude.ts
 *
 * The only place Spendwise Desk calls Claude. Every call goes through `ask()`,
 * which:
 *   1. redacts PII from the system prompt and the user text before sending,
 *   2. redacts the model's reply again before returning it,
 *   3. reports refusals as data (`refused: true`) instead of throwing,
 *   4. never logs prompt or reply text, only redacted error messages.
 *
 * Configure with ANTHROPIC_API_KEY. CLAUDE_MODEL overrides the model.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { logError } from '../log.js';
import { redact, redactText, type PiiKind } from './redact.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high';

export interface AskOptions {
  /** Short label for logs and errors, e.g. "intent" or "policy-answer". */
  purpose: string;
  system: string;
  /** The end user's text (or any text that may contain PII). */
  prompt: string;
  effort?: Effort;
  maxTokens?: number;
  /** JSON schema: when given, the reply is valid JSON matching it. */
  schema?: Record<string, unknown>;
}

export interface AskResult {
  /** Model reply with PII redacted; empty when refused. */
  text: string;
  /** PII kinds removed from the prompt before it was sent. */
  redacted: PiiKind[];
  refused: boolean;
  model: string;
}

export class AiUnavailableError extends Error {
  constructor(message = 'The assistant is unavailable right now. Please try again in a moment.') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

type CreateFn = (params: BetaMessageCreateParamsNonStreaming) => Promise<BetaMessage>;

let createOverride: CreateFn | null = null;
let client: Anthropic | null = null;

/** Tests inject a fake here so no real API call is ever made. Pass null to reset. */
export function setClaudeForTests(fn: CreateFn | null): void {
  createOverride = fn;
}

export function isAiConfigured(): boolean {
  return createOverride !== null || Boolean(process.env.ANTHROPIC_API_KEY);
}

export function model(): string {
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

function create(): CreateFn {
  if (createOverride) return createOverride;
  if (!process.env.ANTHROPIC_API_KEY) throw new AiUnavailableError('ANTHROPIC_API_KEY is not set.');
  client ??= new Anthropic();
  const c = client;
  return (params) => c.beta.messages.create(params);
}

export async function ask(opts: AskOptions): Promise<AskResult> {
  const prompt = redact(opts.prompt);
  const m = model();

  const params: BetaMessageCreateParamsNonStreaming = {
    model: m,
    max_tokens: opts.maxTokens ?? 16000,
    system: redactText(opts.system),
    messages: [{ role: 'user', content: prompt.text }],
    output_config: {
      effort: opts.effort ?? 'medium',
      ...(opts.schema ? { format: { type: 'json_schema', schema: opts.schema } } : {}),
    },
    // On a safety decline, let the API retry on a suitable fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };

  let response: BetaMessage;
  try {
    response = await create()(params);
  } catch (err) {
    if (err instanceof AiUnavailableError) throw err;
    logError(`[ai:${opts.purpose}]`, err);
    throw new AiUnavailableError();
  }

  if (response.stop_reason === 'refusal') {
    return {
      text: '',
      redacted: prompt.found,
      refused: true,
      model: response.model,
    };
  }
  if (response.stop_reason === 'max_tokens') {
    logError(`[ai:${opts.purpose}]`, new Error('reply cut off at max_tokens'));
    throw new AiUnavailableError();
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    text: redactText(text),
    redacted: prompt.found,
    refused: false,
    model: response.model,
  };
}

/** `ask()` with a JSON schema; parses the reply. */
export async function askJson<T>(
  opts: AskOptions & { schema: Record<string, unknown> },
): Promise<{ value: T; redacted: PiiKind[]; refused: false } | { value: null; redacted: PiiKind[]; refused: true }> {
  const res = await ask(opts);
  if (res.refused) return { value: null, redacted: res.redacted, refused: true };
  try {
    return {
      value: JSON.parse(res.text) as T,
      redacted: res.redacted,
      refused: false,
    };
  } catch (err) {
    logError(`[ai:${opts.purpose}]`, err);
    throw new AiUnavailableError();
  }
}
