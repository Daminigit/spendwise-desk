/**
 * src/pulse/approvals.ts
 *
 * The approval gate for the weekly loop. A run only creates PENDING actions;
 * each one shows exactly what will be written and where. A person approves,
 * edits or rejects each action on its own:
 *   - approving one action writes that action's output and nothing else,
 *   - editing changes only that action's payload (and is redacted again),
 *   - rejecting marks only that action,
 *   - a decided action cannot be decided again (conditional update).
 */

import { randomUUID } from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  canonicalAnswers,
  publishedOutputs,
  runActions,
  weeklyRuns,
  type PublishedOutput,
  type RunAction,
  type WeeklyRun,
} from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import { redactText } from '../ai/redact.js';
import type { Explainer } from './weekly.js';

export async function latestRun(orgId: string): Promise<WeeklyRun | null> {
  const [run] = await db
    .select()
    .from(weeklyRuns)
    .where(eq(weeklyRuns.orgId, orgId))
    .orderBy(desc(weeklyRuns.createdAt))
    .limit(1);
  return run ?? null;
}

export async function getRun(orgId: string, runId: string): Promise<WeeklyRun> {
  const [run] = await db
    .select()
    .from(weeklyRuns)
    .where(and(eq(weeklyRuns.orgId, orgId), eq(weeklyRuns.id, runId)));
  if (!run) throw new DomainError('Run not found.', 'not_found');
  return run;
}

export async function listRuns(orgId: string, limit = 12): Promise<WeeklyRun[]> {
  return db
    .select()
    .from(weeklyRuns)
    .where(eq(weeklyRuns.orgId, orgId))
    .orderBy(desc(weeklyRuns.createdAt))
    .limit(limit);
}

export async function actionsForRun(orgId: string, runId: string): Promise<RunAction[]> {
  return db
    .select()
    .from(runActions)
    .where(and(eq(runActions.orgId, orgId), eq(runActions.runId, runId)))
    .orderBy(asc(runActions.createdAt), asc(runActions.kind));
}

async function loadAction(orgId: string, actionId: string): Promise<RunAction> {
  const [a] = await db
    .select()
    .from(runActions)
    .where(and(eq(runActions.orgId, orgId), eq(runActions.id, actionId)));
  if (!a) throw new DomainError('Action not found.', 'not_found');
  return a;
}

/** Claim the pending action for this decision; fails if someone already decided it. */
async function decide(
  orgId: string,
  actionId: string,
  actorId: string,
  status: 'approved' | 'rejected',
): Promise<RunAction> {
  const [a] = await db
    .update(runActions)
    .set({ status, decidedBy: actorId, decidedAt: new Date() })
    .where(and(eq(runActions.orgId, orgId), eq(runActions.id, actionId), eq(runActions.status, 'pending')))
    .returning();
  if (!a) throw new DomainError('This action was already decided.', 'conflict');
  return a;
}

export async function approveAction(orgId: string, actionId: string, actorId: string): Promise<RunAction> {
  await loadAction(orgId, actionId);
  return db.transaction(async (tx) => {
    const [a] = await tx
      .update(runActions)
      .set({ status: 'approved', decidedBy: actorId, decidedAt: new Date() })
      .where(and(eq(runActions.orgId, orgId), eq(runActions.id, actionId), eq(runActions.status, 'pending')))
      .returning();
    if (!a) throw new DomainError('This action was already decided.', 'conflict');
    const p = a.payload as Record<string, unknown>;

    if (a.kind === 'append_doc' || a.kind === 'email_draft') {
      await tx.insert(publishedOutputs).values({
        id: randomUUID(),
        orgId,
        actionId: a.id,
        kind: a.kind === 'append_doc' ? 'doc_entry' : 'email_draft',
        title: String(a.kind === 'append_doc' ? p.title : p.subject),
        body: String(p.body),
        meta: a.kind === 'email_draft' ? { to: p.to } : null,
      });
    } else {
      const e = p as unknown as Explainer;
      // One active canonical answer per topic: the new one replaces the old.
      await tx
        .update(canonicalAnswers)
        .set({ active: false })
        .where(and(eq(canonicalAnswers.orgId, orgId), eq(canonicalAnswers.topic, e.topic)));
      await tx.insert(canonicalAnswers).values({
        id: randomUUID(),
        orgId,
        topic: e.topic,
        title: e.title,
        bullets: e.bullets,
        sources: e.sources,
        lastChecked: e.lastChecked,
        actionId: a.id,
        approvedBy: actorId,
      });
    }
    return a;
  });
}

export async function rejectAction(orgId: string, actionId: string, actorId: string): Promise<RunAction> {
  await loadAction(orgId, actionId);
  return decide(orgId, actionId, actorId, 'rejected');
}

/** Edit the text of a pending doc entry or email draft. Changes only that action. */
export async function editAction(orgId: string, actionId: string, body: string, subject?: string): Promise<RunAction> {
  const a = await loadAction(orgId, actionId);
  if (a.status !== 'pending') throw new DomainError('Only pending actions can be edited.', 'conflict');
  if (a.kind === 'publish_explainer') {
    throw new DomainError(
      'Explainers are approved or rejected as written, so every bullet keeps its source.',
      'invalid',
    );
  }
  const clean = redactText(body).trim().slice(0, 8000);
  if (!clean) throw new DomainError('The text cannot be empty.', 'invalid');
  const payload: Record<string, unknown> = { ...(a.payload as Record<string, unknown>), body: clean };
  if (a.kind === 'email_draft' && subject?.trim()) payload.subject = redactText(subject).trim().slice(0, 200);

  const [updated] = await db
    .update(runActions)
    .set({ payload, edited: true })
    .where(and(eq(runActions.orgId, orgId), eq(runActions.id, actionId), eq(runActions.status, 'pending')))
    .returning();
  if (!updated) throw new DomainError('This action was already decided.', 'conflict');
  return updated;
}

export async function listOutputs(orgId: string): Promise<PublishedOutput[]> {
  return db
    .select()
    .from(publishedOutputs)
    .where(eq(publishedOutputs.orgId, orgId))
    .orderBy(desc(publishedOutputs.createdAt));
}
