/**
 * src/desk/agents.ts
 *
 * The three agents of the response desk. The orchestrator runs them in
 * parallel on every question; each looks at a different data source.
 *
 *   corpus      the official documents: retrieve passages, reuse a canonical
 *               answer if one is approved, otherwise draft from the passages
 *               (src/assistant/policy.ts, model + code)
 *   signals     what people are actually confused about: how often this topic
 *               was asked this week, and how many claim lines were flagged on
 *               it (database, code only)
 *   compliance  the question itself: personal data that had to be removed,
 *               advice or return-figure requests (code only)
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { assistantEvents, categories, claims, expenses } from '../db/schema.js';
import { redact, type PiiKind } from '../ai/redact.js';
import { loadCorpus } from '../corpus/corpus.js';
import { search } from '../corpus/search.js';
import { isAdviceRequest, violatesScope } from '../assistant/guard.js';
import { findCanonical } from '../pulse/canonical.js';
import { flagTopic, REPEAT_THRESHOLD } from '../pulse/weekly.js';
import { FLAG_LABELS } from '../web/util.js';

const WEEK_MS = 7 * 86_400_000;

export interface Signals {
  topic: string;
  topicLabel: string;
  /** Times this topic was asked in the last 7 days, this question included. */
  askedThisWeek: number;
  repeated: boolean;
  /** Claim lines created in the last 7 days whose policy flag relates to this topic. */
  flaggedLines: number;
  flagKinds: string[];
  canonical: boolean;
}

/** Signals agent: how often this comes up, and whether people are also breaking the rule. */
export async function weekSignals(orgId: string, question: string, now = new Date()): Promise<Signals> {
  const { passages } = await loadCorpus(orgId);
  const { hits, terms } = search(passages, question);
  const topic = hits[0]?.passage.id ?? `uncovered:${[...terms].sort().slice(0, 4).join('+') || 'none'}`;
  const since = new Date(now.getTime() - WEEK_MS);

  const [asked] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantEvents)
    .where(
      and(
        eq(assistantEvents.orgId, orgId),
        eq(assistantEvents.intent, 'policy_question'),
        gte(assistantEvents.createdAt, since),
        sql`${assistantEvents.outcome} <> 'refused'`,
        sql`${assistantEvents.meta}::jsonb ->> 'topic' = ${topic}`,
      ),
    );

  const lines = await db
    .select({ flags: expenses.flags, code: categories.code })
    .from(expenses)
    .innerJoin(claims, eq(expenses.claimId, claims.id))
    .innerJoin(categories, eq(expenses.categoryId, categories.id))
    .where(and(eq(claims.orgId, orgId), gte(expenses.createdAt, since)));
  const kinds = new Set<string>();
  let flagged = 0;
  for (const l of lines) {
    const related = l.flags.filter((f) => flagTopic(f, l.code) === topic);
    if (related.length) {
      flagged += 1;
      related.forEach((f) => kinds.add(f));
    }
  }

  const canon = hits.length ? await findCanonical(orgId, [topic]) : null;
  const askedThisWeek = (asked?.n ?? 0) + 1;
  return {
    topic,
    topicLabel: hits[0]?.passage.heading ?? 'Not covered by the sources',
    askedThisWeek,
    repeated: askedThisWeek >= REPEAT_THRESHOLD,
    flaggedLines: flagged,
    flagKinds: [...kinds].map((k) => FLAG_LABELS[k] ?? k),
    canonical: Boolean(canon),
  };
}

export interface Compliance {
  piiFound: PiiKind[];
  advice: boolean;
  scope: boolean;
}

/** Compliance agent: what had to be removed from the question, and whether it asks for advice. */
export async function complianceScan(raw: string, question: string): Promise<Compliance> {
  const found = new Set<PiiKind>([...redact(raw).found, ...redact(question).found]);
  return {
    piiFound: [...found],
    advice: isAdviceRequest(raw) || isAdviceRequest(question),
    scope: violatesScope(question),
  };
}
