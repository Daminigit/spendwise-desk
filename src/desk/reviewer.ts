/**
 * src/desk/reviewer.ts
 *
 * The reviewer: the last step before a draft reaches the queue. It checks the
 * orchestrator's draft, not the drafter's intentions.
 *
 *   code checks   (hard: any failure means verdict "reject")
 *     - a covered draft cites at least one passage
 *     - every cited passage was really retrieved for this question
 *     - three sentences or fewer
 *     - every number is in a cited passage or the question itself
 *     - no advice, recommendations or return figures
 *
 *   model check   (soft: can only flag, never approve or reject)
 *     - a second model reads the draft against its cited passages and says
 *       whether every fact is supported
 *
 * The line is drawn there on purpose: a language model is a useful second
 * reader, but it is not reliable enough to be the gate. Code decides what is
 * blocked; the model only adds a flag for the human to look at.
 */

import { askJson, AiUnavailableError, isAiConfigured } from '../ai/model.js';
import { ungroundedNumbers } from '../corpus/grounding.js';
import { violatesScope } from '../assistant/guard.js';
import type { Passage } from '../corpus/corpus.js';
import type { PolicyDraft } from '../assistant/policy.js';

export type Severity = 'block' | 'warn' | 'info';

export interface ReviewFlag {
  code: string;
  severity: Severity;
  message: string;
}

export type Verdict = 'pass' | 'flag' | 'reject';

export interface Review {
  verdict: Verdict;
  flags: ReviewFlag[];
  /** What the model reviewer concluded: supported, unsupported, or skipped (no model / not needed). */
  model: 'supported' | 'unsupported' | 'skipped';
  checkedAt: string;
}

export const MAX_SENTENCES = 3;

export function sentenceCount(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean).length;
}

/** The draft fields the code checks need. */
export type Checkable = Pick<PolicyDraft, 'reply' | 'covered' | 'sources' | 'retrieved'> &
  Partial<Pick<PolicyDraft, 'invalidCitations' | 'trimmed'>>;

/** Deterministic checks on a draft. Any `block` flag means it must not be sent as written. */
export function codeChecks(d: Checkable, question: string): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const text = d.reply.trim();
  if (!d.covered) return flags; // the fixed "not covered" reply carries no factual claim

  if (!text) flags.push({ code: 'empty', severity: 'block', message: 'The draft is empty.' });
  if (d.sources.length === 0) {
    flags.push({ code: 'no_source', severity: 'block', message: 'The draft cites no source passage.' });
  }
  const retrieved = new Set(d.retrieved.map((p) => p.id));
  const outside = [
    ...(d.invalidCitations ?? []),
    ...d.sources.map((s) => s.passageId).filter((id) => !retrieved.has(id)),
  ];
  if (outside.length) {
    flags.push({
      code: 'bad_citation',
      severity: 'block',
      message: `Cites ${[...new Set(outside)].join(', ')}, which was not retrieved for this question.`,
    });
  }
  if (sentenceCount(text) > MAX_SENTENCES) {
    flags.push({ code: 'too_long', severity: 'block', message: `More than ${MAX_SENTENCES} sentences.` });
  }
  if (violatesScope(text)) {
    flags.push({
      code: 'scope',
      severity: 'block',
      message: 'Contains advice, a recommendation or a return figure. Facts only.',
    });
  }
  const cited = d.sources
    .map((s) => d.retrieved.find((p) => p.id === s.passageId))
    .filter((p): p is Passage => Boolean(p));
  const missing = ungroundedNumbers(text, [...cited.map((p) => p.text), question]);
  if (missing.length) {
    flags.push({
      code: 'ungrounded_number',
      severity: 'block',
      message: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the cited passage or the question.`,
    });
  }
  if (d.trimmed) {
    flags.push({
      code: 'trimmed',
      severity: 'warn',
      message: `The drafter wrote more than ${MAX_SENTENCES} sentences; the draft was cut. Check nothing important was lost.`,
    });
  }
  return flags;
}

interface ModelVerdict {
  supported: boolean;
  issue: string;
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supported', 'issue'],
  properties: { supported: { type: 'boolean' }, issue: { type: 'string' } },
};

const REVIEW_SYSTEM = `You are the reviewer on a finance support desk. You check a draft reply to an employee against the passages it cites.

Set supported to true only if every fact in the draft is stated in the passages, with the same amounts and conditions.
Set supported to false if the draft adds a fact, changes a number or condition, answers a different question, or gives advice or a recommendation.
In issue, say in one short sentence what is unsupported, or leave it empty.`;

/** Second reader: a model checks the draft against its cited passages. Never throws. */
export async function modelCheck(
  draft: string,
  question: string,
  cited: Passage[],
): Promise<{ result: 'supported' | 'unsupported' | 'skipped'; issue: string }> {
  if (!isAiConfigured() || !cited.length) return { result: 'skipped', issue: '' };
  try {
    const res = await askJson<ModelVerdict>({
      purpose: 'review',
      system: REVIEW_SYSTEM,
      prompt:
        `Passages:\n${cited.map((p) => `[${p.id}] ${p.text}`).join('\n')}\n\n` +
        `Question: ${question}\n\nDraft reply: ${draft}`,
      effort: 'low',
      maxTokens: 2000,
      schema: REVIEW_SCHEMA,
    });
    if (res.refused) return { result: 'skipped', issue: '' };
    return res.value.supported
      ? { result: 'supported', issue: '' }
      : { result: 'unsupported', issue: String(res.value.issue ?? '').slice(0, 300) };
  } catch (err) {
    if (err instanceof AiUnavailableError) return { result: 'skipped', issue: '' };
    throw err;
  }
}

/** Code checks, then (only if they pass) the model check, then the verdict. */
export async function review(
  d: PolicyDraft,
  question: string,
  extra: ReviewFlag[] = [],
  opts: { model?: boolean } = {},
): Promise<Review> {
  const flags = [...codeChecks(d, question), ...extra];
  let model: Review['model'] = 'skipped';
  const blocked = flags.some((f) => f.severity === 'block');
  // The model reads only drafts the code checks let through, and only model-written ones:
  // a word-for-word quote of the passage is grounded by construction.
  if (!blocked && d.covered && d.drafter === 'model' && opts.model !== false) {
    const cited = d.sources
      .map((s) => d.retrieved.find((p) => p.id === s.passageId))
      .filter((p): p is Passage => Boolean(p));
    const m = await modelCheck(d.reply, question, cited);
    model = m.result;
    if (m.result === 'unsupported') {
      flags.push({
        code: 'model_unsupported',
        severity: 'warn',
        message: `Model reviewer: ${m.issue || 'not every fact is in the cited passage.'}`,
      });
    }
  }
  return { verdict: verdictOf(flags), flags, model, checkedAt: new Date().toISOString() };
}

export function verdictOf(flags: ReviewFlag[]): Verdict {
  if (flags.some((f) => f.severity === 'block')) return 'reject';
  if (flags.some((f) => f.severity === 'warn')) return 'flag';
  return 'pass';
}
