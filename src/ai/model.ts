/**
 * src/ai/model.ts
 *
 * The only place Spendwise Desk calls a language model or speech-to-text.
 * Two providers, chosen by AI_PROVIDER (or by whichever key is set):
 *
 *   groq       GROQ_API_KEY       openai/gpt-oss-120b (GROQ_MODEL), intent on
 *                                 openai/gpt-oss-20b (GROQ_FAST_MODEL), Whisper
 *                                 whisper-large-v3-turbo for voice
 *   anthropic  ANTHROPIC_API_KEY  claude-opus-5-5 (CLAUDE_MODEL)
 *
 * Whatever the provider, every call goes through `ask()`, which:
 *   1. redacts PII from the system prompt and the user text before sending,
 *   2. redacts the model's reply again before returning it,
 *   3. reports refusals as data (`refused: true`) instead of throwing,
 *   4. for JSON replies, checks the reply against the schema in code and
 *      retries once; a reply that still does not fit is never acted on,
 *   5. never logs prompt or reply text, only redacted error messages.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import Groq, { toFile } from 'groq-sdk';
import { logError } from '../log.js';
import { redact, redactText, type PiiKind } from './redact.js';
import { checkSchema, toGroqSchema } from './schema.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_GROQ_FAST_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_WHISPER_MODEL = 'whisper-large-v3-turbo';

/** Calls that only classify short text use the faster model (and its own quota). */
const FAST_PURPOSES = new Set(['intent', 'review']);

export type Effort = 'low' | 'medium' | 'high';
export type Provider = 'groq' | 'anthropic';

export interface AskOptions {
  /** Short label for logs and errors, e.g. "intent" or "policy-answer". */
  purpose: string;
  system: string;
  /** The end user's text (or any text that may contain PII). */
  prompt: string;
  effort?: Effort;
  maxTokens?: number;
  /** JSON schema: when given, the reply must be JSON matching it. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Provider selection and test fakes
// ─────────────────────────────────────────────────────────────────────────────

type AnthropicCreate = (params: BetaMessageCreateParamsNonStreaming) => Promise<BetaMessage>;

export interface GroqChatParams {
  model: string;
  messages: { role: 'system' | 'user'; content: string }[];
  max_completion_tokens: number;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
}
export interface GroqChatReply {
  model: string;
  choices: { message: { content: string | null; refusal?: string | null }; finish_reason: string | null }[];
}
type GroqCreate = (params: GroqChatParams) => Promise<GroqChatReply>;
type Transcribe = (audio: Buffer, filename: string) => Promise<string>;

let anthropicOverride: AnthropicCreate | null = null;
let groqOverride: GroqCreate | null = null;
let transcribeOverride: Transcribe | null = null;
let anthropicClient: Anthropic | null = null;
let groqClient: Groq | null = null;

/** Tests inject fakes so no real API call is ever made. Pass null to reset. */
export function setClaudeForTests(fn: AnthropicCreate | null): void {
  anthropicOverride = fn;
}
export function setGroqForTests(fn: GroqCreate | null): void {
  groqOverride = fn;
}
export function setTranscribeForTests(fn: Transcribe | null): void {
  transcribeOverride = fn;
}

export function provider(): Provider | null {
  if (anthropicOverride) return 'anthropic';
  if (groqOverride) return 'groq';
  const chosen = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (chosen === 'groq') return process.env.GROQ_API_KEY ? 'groq' : null;
  if (chosen === 'anthropic') return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export function isAiConfigured(): boolean {
  return provider() !== null;
}

/** Server-side speech-to-text (Whisper on Groq) is available. */
export function isTranscriptionConfigured(): boolean {
  return transcribeOverride !== null || Boolean(process.env.GROQ_API_KEY);
}

export function modelFor(purpose: string): string {
  if (provider() === 'groq') {
    return FAST_PURPOSES.has(purpose)
      ? process.env.GROQ_FAST_MODEL || DEFAULT_GROQ_FAST_MODEL
      : process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  }
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

/** Human-readable label of what is answering, for the UI and eval reports. */
export function modelLabel(): string {
  const p = provider();
  if (!p) return 'none';
  return p === 'groq' ? `Groq ${modelFor('answer')} (intent: ${modelFor('intent')})` : `Claude ${modelFor('answer')}`;
}

function groq(): Groq {
  groqClient ??= new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: Number(process.env.AI_MAX_RETRIES ?? 4) });
  return groqClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// One raw call, per provider
// ─────────────────────────────────────────────────────────────────────────────

interface Raw {
  text: string;
  refused: boolean;
  truncated: boolean;
  model: string;
}

async function callAnthropic(opts: AskOptions, system: string, prompt: string): Promise<Raw> {
  let create = anthropicOverride;
  if (!create) {
    anthropicClient ??= new Anthropic();
    const c = anthropicClient;
    create = (params) => c.beta.messages.create(params);
  }
  const response = await create({
    model: modelFor(opts.purpose),
    max_tokens: opts.maxTokens ?? 16000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      effort: opts.effort ?? 'medium',
      ...(opts.schema ? { format: { type: 'json_schema', schema: opts.schema } } : {}),
    },
    // On a safety decline, let the API retry on a suitable fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  return {
    text: response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    refused: response.stop_reason === 'refusal',
    truncated: response.stop_reason === 'max_tokens',
    model: response.model,
  };
}

async function callGroq(opts: AskOptions, system: string, prompt: string): Promise<Raw> {
  const create: GroqCreate =
    groqOverride ?? ((params) => groq().chat.completions.create(params) as unknown as Promise<GroqChatReply>);
  const params: GroqChatParams = {
    model: modelFor(opts.purpose),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    // gpt-oss models reason before answering; leave room for that.
    max_completion_tokens: Math.min(opts.maxTokens ?? 8000, 8000),
    ...(opts.schema
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: opts.purpose.replace(/[^a-z0-9_-]/gi, '_'),
              strict: true,
              schema: toGroqSchema(opts.schema),
            },
          },
        }
      : {}),
  };
  const r = await create(params);
  const choice = r.choices[0];
  return {
    text: choice?.message.content ?? '',
    refused: Boolean(choice?.message.refusal) || choice?.finish_reason === 'content_filter',
    truncated: choice?.finish_reason === 'length',
    model: r.model,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional spacing between calls (AI_MIN_INTERVAL_MS), so batch jobs like the
 * eval stay under a free tier's requests-per-minute limit. 0 by default.
 */
let nextSlot = 0;
async function throttle(): Promise<void> {
  const gap = Number(process.env.AI_MIN_INTERVAL_MS ?? 0);
  if (!gap) return;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gap;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

export async function ask(opts: AskOptions): Promise<AskResult> {
  const p = provider();
  if (!p) throw new AiUnavailableError('No AI provider is configured (GROQ_API_KEY or ANTHROPIC_API_KEY).');
  if (!anthropicOverride && !groqOverride) await throttle();
  const prompt = redact(opts.prompt);
  const system = redactText(opts.system);

  let raw: Raw;
  try {
    raw = p === 'groq' ? await callGroq(opts, system, prompt.text) : await callAnthropic(opts, system, prompt.text);
  } catch (err) {
    logError(`[ai:${opts.purpose}]`, err);
    throw new AiUnavailableError();
  }

  if (raw.refused) return { text: '', redacted: prompt.found, refused: true, model: raw.model };
  if (raw.truncated) {
    logError(`[ai:${opts.purpose}]`, new Error('reply cut off at the token limit'));
    throw new AiUnavailableError();
  }
  return { text: redactText(raw.text), redacted: prompt.found, refused: false, model: raw.model };
}

/** `ask()` with a JSON schema. The reply is parsed and checked against the schema in code. */
export async function askJson<T>(
  opts: AskOptions & { schema: Record<string, unknown> },
): Promise<{ value: T; redacted: PiiKind[]; refused: false } | { value: null; redacted: PiiKind[]; refused: true }> {
  let lastProblem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ask(opts);
    if (res.refused) return { value: null, redacted: res.redacted, refused: true };
    let value: unknown;
    try {
      value = JSON.parse(res.text);
    } catch {
      lastProblem = 'reply was not valid JSON';
      continue;
    }
    const problem = checkSchema(value, opts.schema);
    if (!problem) return { value: value as T, redacted: res.redacted, refused: false };
    lastProblem = problem;
  }
  logError(`[ai:${opts.purpose}]`, new Error(`reply did not match the schema: ${lastProblem}`));
  throw new AiUnavailableError();
}

/**
 * Speech to text with Whisper on Groq. The audio is sent once and not stored;
 * the transcript is returned to the speaker's own browser and then goes through
 * the same redaction as typed text.
 */
export async function transcribe(audio: Buffer, filename: string): Promise<string> {
  if (transcribeOverride) return (await transcribeOverride(audio, filename)).trim();
  if (!process.env.GROQ_API_KEY) throw new AiUnavailableError('Voice transcription is not configured (GROQ_API_KEY).');
  await throttle();
  try {
    const r = await groq().audio.transcriptions.create({
      model: process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
      file: await toFile(audio, filename),
      // Vocabulary hint: spellings Whisper should prefer in this domain.
      // Whisper copies the prompt's style: a romanised Hinglish sample keeps
      // Hindi words in Latin script ("aaj lunch ka bill").
      prompt:
        'Expense claim. Aaj lunch ka bill 500 rupees hai, add kar do. Kal Uber se airport gaya. ' +
        'GSTIN, receipt, invoice, hotel, lodging, Ola, Bangalore, Mumbai.',
      temperature: 0,
      // Hinglish otherwise comes back in Devanagari; English keeps it in Latin
      // script, which the search, the redaction and the text box all expect.
      language: process.env.WHISPER_LANGUAGE || 'en',
    });
    return String((r as { text?: string }).text ?? '').trim();
  } catch (err) {
    logError('[ai:transcribe]', err);
    throw new AiUnavailableError('Could not transcribe the audio. Please try again or type instead.');
  }
}
