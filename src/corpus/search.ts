/**
 * src/corpus/search.ts
 *
 * Keyword retrieval over a few dozen passages. Deterministic and explainable:
 * a passage scores by the rarity (IDF) of the question words it contains,
 * after a small synonym map ("hotel" → lodging, "cab" → travel). A question
 * that matches nothing meaningful gets no passages, and the assistant says
 * it is not covered instead of asking the model to guess.
 */

import type { Passage } from './corpus.js';

const STOPWORDS = new Set(
  (
    'a an the is are was were be been am i me my we our you your it its this that these those to of in on at for from by with ' +
    'and or but if so do does did can could should would will shall may might must what which who whom how when where why ' +
    'there here any some all much many more most than then also just about into over per not no yes please tell know ' +
    'kya hai hain ka ki ke ko mein main mera meri ' +
    // Domain filler: present in most passages, so it says nothing about which one fits.
    'expense expenses expensed claim claims claimed claimable spend spent spending company policy rupees rupee rs inr need needed required'
  ).split(/\s+/),
);

/** Everyday words → the words the sources use. */
const SYNONYMS: Record<string, string[]> = {
  hotel: ['lodging'],
  stay: ['lodging'],
  accommodation: ['lodging'],
  room: ['lodging'],
  food: ['meals'],
  lunch: ['meals'],
  dinner: ['meals'],
  breakfast: ['meals'],
  meal: ['meals'],
  khana: ['meals'],
  cab: ['travel'],
  taxi: ['travel'],
  uber: ['travel'],
  ola: ['travel'],
  flight: ['travel'],
  train: ['travel'],
  fuel: ['travel'],
  bill: ['receipt', 'invoice'],
  bills: ['receipt', 'invoice'],
  receipts: ['receipt'],
  invoices: ['invoice'],
  saturday: ['weekend'],
  sunday: ['weekend'],
  weekends: ['weekend'],
  cap: ['limit'],
  maximum: ['limit'],
  max: ['limit'],
  limits: ['limit'],
  allowed: ['limit'],
  gst: ['gstin', 'tax'],
  gstn: ['gstin'],
  software: ['software'],
  laptop: ['office'],
  stationery: ['office'],
  client: ['entertainment'],
  flag: ['flags', 'flagged'],
  flagged: ['flags'],
  reject: ['flags', 'approver'],
  rejected: ['flags', 'approver'],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9₹\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function stem(w: string): string {
  return w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w;
}

/** The user's own words weigh 1; words added through the synonym map weigh less. */
const SYNONYM_WEIGHT = 0.5;

function expand(words: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of words) out.set(stem(w), 1);
  for (const w of words) {
    for (const s of SYNONYMS[w] ?? []) if (!out.has(stem(s))) out.set(stem(s), SYNONYM_WEIGHT);
  }
  return out;
}

export interface SearchHit {
  passage: Passage;
  score: number;
  matched: string[];
}

/** Minimum score for a passage to count as evidence. */
export const MIN_SCORE = 1.2;

export function search(passages: Passage[], question: string, k = 4): { hits: SearchHit[]; terms: string[] } {
  const weights = expand(tokenize(question));
  const terms = [...weights.keys()];
  if (!terms.length) return { hits: [], terms };

  const bodies = passages.map((p) => tokenize(`${p.heading} ${p.text}`).map(stem));
  const docs = bodies.map((b) => new Set(b));
  const headings = passages.map((p) => new Set(tokenize(p.heading).map(stem)));
  const n = docs.length;
  const avgLen = bodies.reduce((s, b) => s + b.length, 0) / Math.max(1, n);
  const idf = (t: string) => {
    const df = docs.filter((d) => d.has(t)).length;
    return df === 0 ? 0 : Math.log(1 + n / df);
  };

  const hits = passages
    .map((passage, i) => {
      const matched = terms.filter((t) => docs[i].has(t));
      // A word in the heading counts double: "Supplier GSTIN" beats a long
      // catch-all passage that merely mentions GSTIN. Long passages are
      // normalised down a little (BM25-style) so they do not win by length.
      const raw = matched.reduce((s, t) => s + idf(t) * weights.get(t)! * (headings[i].has(t) ? 2 : 1), 0);
      const score = raw / (0.6 + 0.4 * (bodies[i].length / avgLen));
      return { passage, score, matched };
    })
    .filter((h) => h.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return { hits, terms };
}
