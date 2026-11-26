/**
 * src/pulse/canonical.ts
 *
 * Approved explainers become canonical answers. When a policy question
 * retrieves a passage that has an active canonical answer, the assistant
 * replies with that approved text instead of drafting a new one.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { canonicalAnswers, type CanonicalAnswer } from '../db/schema.js';

export async function findCanonical(orgId: string, topics: string[]): Promise<CanonicalAnswer | null> {
  if (!topics.length) return null;
  const rows = await db
    .select()
    .from(canonicalAnswers)
    .where(
      and(
        eq(canonicalAnswers.orgId, orgId),
        eq(canonicalAnswers.active, true),
        inArray(canonicalAnswers.topic, topics),
      ),
    )
    .orderBy(desc(canonicalAnswers.createdAt));
  // Prefer the best-ranked topic.
  for (const t of topics) {
    const hit = rows.find((r) => r.topic === t);
    if (hit) return hit;
  }
  return null;
}

export async function markReused(id: string): Promise<void> {
  await db
    .update(canonicalAnswers)
    .set({ timesReused: sql`${canonicalAnswers.timesReused} + 1` })
    .where(eq(canonicalAnswers.id, id));
}

export async function listCanonical(orgId: string): Promise<CanonicalAnswer[]> {
  return db
    .select()
    .from(canonicalAnswers)
    .where(eq(canonicalAnswers.orgId, orgId))
    .orderBy(desc(canonicalAnswers.active), desc(canonicalAnswers.createdAt));
}

export async function retireCanonical(orgId: string, id: string): Promise<void> {
  await db
    .update(canonicalAnswers)
    .set({ active: false })
    .where(and(eq(canonicalAnswers.orgId, orgId), eq(canonicalAnswers.id, id)));
}
