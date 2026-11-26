/**
 * src/assistant/policy.ts
 *
 * Cited answers to expense-policy questions.
 *
 *   question ──► keyword search over the corpus (code)
 *            ──► no passage above the threshold? → "not covered", name what was searched
 *            ──► Claude answers ONLY from the retrieved passages, as JSON
 *                { covered, answer, passage_ids }
 *            ──► code checks: cited ids were really retrieved, ≤3 sentences,
 *                no advice or return figures; otherwise "not covered"
 *
 * Every answer that is shown carries a source link and its last-checked date.
 */

import { askJson, AiUnavailableError } from '../ai/model.js';
import { loadCorpus, type Passage } from '../corpus/corpus.js';
import { search } from '../corpus/search.js';
import { violatesScope } from './guard.js';
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

export async function answerPolicyQuestion(user: Actor, question: string): Promise<PolicyAnswer> {
  const { sources, passages } = await loadCorpus(user.orgId);
  const { hits, terms } = search(passages, question);
  const searched = [...sources.map((s) => s.title), ...(terms.length ? [`terms: ${terms.join(', ')}`] : [])];
  const topic = hits[0]?.passage.id ?? `uncovered:${[...terms].sort().slice(0, 4).join('+') || 'none'}`;

  const notCovered = (): PolicyAnswer => ({
    reply: `I couldn't find this in the sources I have. I searched ${sources.map((s) => s.title).join(' and ')}. Please ask your finance team.`,
    covered: false,
    sources: [],
    searched,
    topic,
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
      reply: capSentences(canon.bullets.map((b) => b.text.replace(/\s*[.;]?$/, '.')).join(' '), 3),
      covered: true,
      sources: canon.sources.slice(0, 2).map((src, i) => ({
        title: src.title,
        url: src.url,
        lastChecked: src.lastChecked,
        passageId: canon.bullets[i]?.passageId ?? canon.topic,
      })),
      searched,
      topic: canon.topic,
      canonical: { id: canon.id, title: canon.title },
      drafter: 'canonical',
    };
  }

  const byId = new Map<string, Passage>(hits.map((h) => [h.passage.id, h.passage]));
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
        reply: capSentences(best.passage.text, 3),
        covered: true,
        sources: [
          {
            title: `${best.passage.sourceTitle}: ${best.passage.heading}`,
            url: best.passage.url,
            lastChecked: best.passage.lastChecked,
            passageId: best.passage.id,
          },
        ],
        searched,
        topic,
        canonical: null,
        drafter: 'extractive',
      };
    }
    throw err;
  }

  // Code-level checks on what the model returned.
  // Defensive: treat a malformed reply as no answer.
  const ids = Array.isArray(model?.passage_ids) ? model.passage_ids : [];
  const cited = [...new Set(ids)].map((id) => byId.get(String(id))).filter((p): p is Passage => Boolean(p));
  const answer = capSentences(String(model?.answer ?? '').trim(), 3);
  if (model?.covered !== true || !answer || cited.length === 0 || violatesScope(answer)) return notCovered();

  return {
    reply: answer,
    covered: true,
    sources: cited.slice(0, 2).map((p) => ({
      title: `${p.sourceTitle}: ${p.heading}`,
      url: p.url,
      lastChecked: p.lastChecked,
      passageId: p.id,
    })),
    searched,
    topic,
    canonical: null,
    drafter: 'model',
  };
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
