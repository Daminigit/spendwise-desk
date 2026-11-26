/**
 * src/assistant/policy.ts
 *
 * Cited answers to expense-policy questions.
 *
 *   question ──► keyword search over the corpus (code)
 *            ──► no passage above the threshold? → "not covered", name what was searched
 *            ──► Claude answers ONLY from the retrieved passages, as JSON
 *                { covered, answer, passage_ids }
 *            ──► the reviewer (src/desk/reviewer.ts) checks the draft in code:
 *                cited ids were really retrieved, ≤3 sentences, every number
 *                is in a cited passage, no advice or return figures
 *
 * Every answer that is shown carries a source link and its last-checked date.
 */

import { askJson, AiUnavailableError } from '../ai/model.js';
import { loadCorpus, type Passage } from '../corpus/corpus.js';
import { search } from '../corpus/search.js';
import { codeChecks } from '../desk/reviewer.js';
import { findCanonical, markReused } from '../pulse/canonical.js';
import type { Actor } from './interpret.js';

export interface PolicySource {
  title: string;
  url: string;
  lastChecked: string;
  passageId: string;
}

export interface PolicyAnswer {
  reply: string;
  covered: boolean;
  sources: PolicySource[];
  /** Source titles searched, and the search terms used (shown when not covered). */
  searched: string[];
  /** Grouping key for the weekly pulse: the best-matching passage, or the uncovered terms. */
  topic: string;
  /** Set when an approved canonical answer was reused instead of drafting a new one. */
  canonical: { id: string; title: string } | null;
  /** Who wrote the reply: Claude from passages, an approved canonical answer, the passage itself, or nobody. */
  drafter: 'model' | 'canonical' | 'extractive' | 'none';
}

/** Without Claude, quote the best passage only when the match is this strong. */
export const EXTRACTIVE_MIN_SCORE = 3;

interface ModelAnswer {
  covered: boolean;
  answer: string;
  passage_ids: string[];
}

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['covered', 'answer', 'passage_ids'],
  properties: {
    covered: { type: 'boolean' },
    answer: { type: 'string' },
    passage_ids: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You answer employees' questions about their company's expense policy and Indian GST invoice rules.

Use ONLY the numbered passages provided. If they do not answer the question, set covered to false and answer with an empty string.
If they do, set covered to true and answer in at most three short sentences, using the passages' facts exactly (amounts, limits, rules).
List in passage_ids the id of every passage you used.
State facts only. Never recommend, advise, or give tax-planning, investment, or return figures. Never invent amounts or rules.`;

/** A draft before review: what the corpus agent produced, plus what the reviewer needs to check it. */
export interface PolicyDraft extends PolicyAnswer {
  /** Passages the search returned (the only ones the draft may cite). */
  retrieved: Passage[];
  /** Score of the best passage (0 when nothing matched). */
  bestScore: number;
  /** Passage ids the model cited that were not among the retrieved passages. */
  invalidCitations: string[];
  /** True when the model wrote more than three sentences and the draft was cut. */
  trimmed: boolean;
}

/** The reply when nothing in the corpus answers the question: says so and names what was searched. */
export function notCoveredReply(sourceTitles: string[]): string {
  return `I couldn't find this in the sources I have. I searched ${sourceTitles.join(' and ')}. Please ask your finance team.`;
}

/**
 * The corpus agent: retrieve, reuse a canonical answer if one is approved,
 * otherwise draft from the passages. No checks are applied here; the
 * reviewer (src/desk/reviewer.ts) decides whether the draft may be used.
 */
export async function draftPolicyAnswer(user: Actor, question: string): Promise<PolicyDraft> {
  const { sources, passages } = await loadCorpus(user.orgId);
  const { hits, terms } = search(passages, question);
  const searched = [...sources.map((s) => s.title), ...(terms.length ? [`terms: ${terms.join(', ')}`] : [])];
  const topic = hits[0]?.passage.id ?? `uncovered:${[...terms].sort().slice(0, 4).join('+') || 'none'}`;
  const retrieved = hits.map((h) => h.passage);
  const base = { searched, topic, retrieved, bestScore: hits[0]?.score ?? 0, invalidCitations: [], trimmed: false };

  const notCovered = (): PolicyDraft => ({
    ...base,
    reply: notCoveredReply(sources.map((s) => s.title)),
    covered: false,
    sources: [],
    canonical: null,
    drafter: 'none',
  });

  if (!hits.length) return notCovered();

  // An approved explainer for this topic is the canonical answer: reuse it, don't draft fresh.
  const canon = await findCanonical(
    user.orgId,
    hits.slice(0, 2).map((h) => h.passage.id),
  );
  if (canon) {
    await markReused(canon.id);
    return {
      ...base,
      reply: capSentences(canon.bullets.map((b) => b.text.replace(/\s*[.;]?$/, '.')).join(' '), 3),
      covered: true,
      sources: canon.sources.slice(0, 2).map((src, i) => ({
        title: src.title,
        url: src.url,
        lastChecked: src.lastChecked,
        passageId: canon.bullets[i]?.passageId ?? canon.topic,
      })),
      topic: canon.topic,
      canonical: { id: canon.id, title: canon.title },
      drafter: 'canonical',
    };
  }

  const byId = new Map<string, Passage>(retrieved.map((p) => [p.id, p]));
  const context = hits
    .map((h) => `[${h.passage.id}] (${h.passage.sourceTitle} — ${h.passage.heading}) ${h.passage.text}`)
    .join('\n');

  let model: ModelAnswer;
  try {
    const res = await askJson<ModelAnswer>({
      purpose: 'policy-answer',
      system: SYSTEM,
      prompt: `Passages:\n${context}\n\nQuestion: ${question}`,
      effort: 'low',
      maxTokens: 4000,
      schema: ANSWER_SCHEMA,
    });
    if (res.refused) return notCovered();
    model = res.value;
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      // No model: quote the best passage word for word (grounded by construction),
      // but only when the match is strong; otherwise say it is not covered.
      const best = hits[0];
      if (best.score < EXTRACTIVE_MIN_SCORE) return notCovered();
      return {
        ...base,
        reply: capSentences(best.passage.text, 3),
        covered: true,
        sources: [toSource(best.passage)],
        canonical: null,
        drafter: 'extractive',
      };
    }
    throw err;
  }

  // Defensive: treat a malformed reply as no answer.
  const ids = Array.isArray(model?.passage_ids) ? [...new Set(model.passage_ids.map(String))] : [];
  const cited = ids.map((id) => byId.get(id)).filter((p): p is Passage => Boolean(p));
  const full = String(model?.answer ?? '').trim();
  const answer = capSentences(full, 3);
  if (model?.covered !== true || !answer) return notCovered();

  return {
    ...base,
    reply: answer,
    covered: true,
    sources: cited.slice(0, 2).map(toSource),
    canonical: null,
    drafter: 'model',
    invalidCitations: ids.filter((id) => !byId.has(id)),
    trimmed: answer !== full,
  };
}

/**
 * Draft and apply the reviewer's code checks in one step: a draft that fails
 * any blocking check becomes "not covered". Used where there is no human in
 * the loop to read the reviewer's verdict (the evals' drafting checks).
 */
export async function answerPolicyQuestion(user: Actor, question: string): Promise<PolicyAnswer> {
  const d = await draftPolicyAnswer(user, question);
  if (!d.covered || d.drafter === 'canonical') return strip(d);
  if (codeChecks(d, question).some((f) => f.severity === 'block')) {
    const { sources } = await loadCorpus(user.orgId);
    return strip({ ...d, reply: notCoveredReply(sources.map((s) => s.title)), covered: false, sources: [], drafter: 'none' });
  }
  return strip(d);
}

function strip(d: PolicyDraft): PolicyAnswer {
  const { reply, covered, sources, searched, topic, canonical, drafter } = d;
  return { reply, covered, sources, searched, topic, canonical, drafter };
}

function toSource(p: Passage): PolicySource {
  return { title: `${p.sourceTitle}: ${p.heading}`, url: p.url, lastChecked: p.lastChecked, passageId: p.id };
}

/** Keep at most `n` sentences. */
export function capSentences(text: string, n: number): string {
  // A sentence ends at . ! or ? followed by a space or the end (so "₹1,500.00" stays whole).
  return text
    .split(/(?<=[.!?])\s+/)
    .slice(0, n)
    .join(' ')
    .trim();
}
