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

import { askJson, AiUnavailableError } from '../ai/claude.js';
import { loadCorpus, type Passage } from '../corpus/corpus.js';
import { search } from '../corpus/search.js';
import { violatesScope } from './guard.js';
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
}

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

  const notCovered = (): PolicyAnswer => ({
    reply: `I couldn't find this in the sources I have. I searched ${sources.map((s) => s.title).join(' and ')}. Please ask your finance team.`,
    covered: false,
    sources: [],
    searched,
  });

  if (!hits.length) return notCovered();

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
      return {
        ...notCovered(),
        reply: 'The assistant is unavailable right now. Please check the policy page in Settings.',
      };
    }
    throw err;
  }

  // Code-level checks on what the model returned.
  const cited = [...new Set(model.passage_ids)].map((id) => byId.get(id)).filter((p): p is Passage => Boolean(p));
  const answer = capSentences(model.answer.trim(), 3);
  if (!model.covered || !answer || cited.length === 0 || violatesScope(answer)) return notCovered();

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
