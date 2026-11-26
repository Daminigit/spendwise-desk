/**
 * src/assistant/policy.ts
 *
 * Answers policy questions. Placeholder until the cited source corpus lands
 * (part 3): it says plainly that it cannot answer yet, which is the same
 * "not covered" behaviour the finished version uses.
 */

import type { Actor } from './interpret.js';

export interface PolicyAnswer {
  reply: string;
  covered: boolean;
  sources: { title: string; url: string; lastChecked: string }[];
  searched: string[];
}

export async function answerPolicyQuestion(_user: Actor, _question: string): Promise<PolicyAnswer> {
  return {
    reply: "I can't answer policy questions yet. Please check the policy page in Settings or ask finance.",
    covered: false,
    sources: [],
    searched: [],
  };
}
