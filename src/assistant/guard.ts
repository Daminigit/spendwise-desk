/**
 * src/assistant/guard.ts
 *
 * Scope rules enforced in code, before and after the model runs:
 *   - no financial, investment or tax-planning advice,
 *   - no return, yield or performance figures,
 *   - no buy / sell / invest recommendations.
 *
 * The model is also told this in its prompt, but this check runs whatever the
 * model says, so a rephrased request that slips past the prompt still stops here.
 */

/** Clear advice requests: refused whatever else the message says. */
const STRONG_ADVICE: RegExp[] = [
  /\bshould i (buy|sell|invest|hold|put (my )?money)\b/i,
  /\b(buy|sell|invest(ing)?|put (my )?money)\b.{0,30}\b(stocks?|shares?|mutual funds?|sip|fd|fixed deposits?|crypto|bitcoin|gold|bonds?|nifty|sensex|ipo|etf)\b/i,
  /\b(which|best|good|top|recommend(ed)?|suggest(ed)?)\b.{0,25}\b(stocks?|shares?|mutual funds?|sip|funds?|investments?|portfolio|crypto|insurance plans?|tax[- ]saving)\b/i,
  /\b(investment|financial|tax[- ]planning|tax[- ]saving|wealth) (advice|tips|plan|strategy)\b/i,
  /\bhow (can|do|should) i (save|reduce|avoid) (my )?(income )?tax\b/i,
  // Naming an investment product at all is out of scope for an expense assistant.
  // ("stock" alone is left out: "printer paper stock" is an expense, not advice.)
  /\b(mutual funds?|sips?|crypto(currency)?|bitcoin|ipos?|etfs?|demat|fixed deposits?|ppf|elss|nps|equity|equities)\b/i,
  // Growing or parking money, however it is phrased.
  /\b(park|grow|double|multiply|invest)\b.{0,40}\b(money|savings|returns?|\d+\s*(years?|yrs?))\b/i,
  /\b(good|better|best|high|higher|maximum)\s+returns?\b/i,
];

/** Return / market talk: refused unless the message is clearly about an expense. */
const WEAK_ADVICE: RegExp[] = [
  /\b(rate of return|returns? on|expected returns?|annual returns?|xirr|cagr|yield|interest rate on|how much (will|would) (i|it) (earn|make|grow))\b/i,
  /\b(portfolio|nifty|sensex|stock market|share market)\b/i,
  /\b(what|how much|which) returns?\b|\breturns? (will|would|can|do) (i|we|it) (get|earn|make|give)\b/i,
];

/** Ordinary expense words that can look like advice ("return flight"). */
const EXPENSE_CONTEXT =
  /\b(return (flight|ticket|trip|journey|cab|taxi)|tax invoice|gst|gstin|reimburse\w*|claims?|expenses?|receipts?|bills?)\b/i;

export function isAdviceRequest(text: string): boolean {
  if (STRONG_ADVICE.some((re) => re.test(text))) return true;
  return WEAK_ADVICE.some((re) => re.test(text)) && !EXPENSE_CONTEXT.test(text);
}

export const ADVICE_REFUSAL =
  "I can't give investment, tax-planning or returns advice. I can log expenses, check claim status and answer questions about your company's expense policy.";

/** Phrases a factual reply must never contain (checked on model output). */
const FORBIDDEN_OUTPUT: RegExp[] = [
  /\b(you should|i recommend|i'd recommend|i suggest|we recommend)\b.{0,40}\b(buy|sell|invest|stock|fund|sip)\b/i,
  /\b\d+(\.\d+)?\s?%\s*(returns?|yield|p\.?a\.?|annually|cagr|xirr)\b/i,
  /\b(guaranteed|assured) returns?\b/i,
];

export function violatesScope(output: string): boolean {
  return FORBIDDEN_OUTPUT.some((re) => re.test(output));
}
