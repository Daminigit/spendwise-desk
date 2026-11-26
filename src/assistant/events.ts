/**
 * src/assistant/events.ts
 *
 * One row per assistant turn. Only redacted text is ever stored; meta is
 * redacted too. These rows feed the weekly pulse (repeated questions).
 */

import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { assistantEvents } from '../db/schema.js';
import { redact, redactDeep } from '../ai/redact.js';

export type Channel = 'voice' | 'text';
export type Outcome =
  'needs_info' | 'previewed' | 'confirmed' | 'cancelled' | 'answered' | 'not_covered' | 'refused' | 'error';

export async function recordEvent(e: {
  orgId: string;
  userId: string;
  channel: Channel;
  intent: string;
  outcome: Outcome;
  text: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const r = redact(e.text);
  await db.insert(assistantEvents).values({
    id: randomUUID(),
    orgId: e.orgId,
    userId: e.userId,
    channel: e.channel,
    intent: e.intent,
    outcome: e.outcome,
    textRedacted: r.text.slice(0, 2000),
    piiFound: r.found,
    meta: e.meta ? redactDeep(e.meta) : null,
  });
}

/** True if an action with this nonce was already confirmed (stops double-submits). */
export async function nonceUsed(orgId: string, nonce: string): Promise<boolean> {
  const rows = await db
    .select({ id: assistantEvents.id })
    .from(assistantEvents)
    .where(
      and(
        eq(assistantEvents.orgId, orgId),
        eq(assistantEvents.outcome, 'confirmed'),
        sql`${assistantEvents.meta}::jsonb ->> 'nonce' = ${nonce}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
