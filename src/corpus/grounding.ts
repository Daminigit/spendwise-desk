/**
 * src/corpus/grounding.ts
 *
 * Numeric grounding, enforced in code: every rupee amount, percentage or plain
 * number in a model-written answer must appear in the passages it cites (or in
 * the user's own question). An answer with an invented figure is not shown.
 */

/** Normalised numbers in a text: "₹1,500.00" → "1500", "12%" → "12", "2.5" → "2.5". */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, '').replace(/\.0+$/, ''));
}

/** Numbers in `answer` that appear in none of `evidence`. Empty means grounded. */
export function ungroundedNumbers(answer: string, evidence: string[]): string[] {
  const allowed = new Set(evidence.flatMap(numbersIn));
  return [...new Set(numbersIn(answer))].filter((n) => !allowed.has(n));
}
