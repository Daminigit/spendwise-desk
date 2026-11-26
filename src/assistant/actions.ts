/**
 * src/assistant/actions.ts
 *
 * The approval gate for the assistant. The interpreter never writes anything:
 * it returns a preview plus a signed action token. Only `confirmAction()`
 * writes, and only the exact action that was previewed:
 *   - the token is HMAC-signed with SESSION_SECRET, so it cannot be edited,
 *   - it is bound to the user who saw the preview,
 *   - it expires after 15 minutes,
 *   - its nonce can be confirmed once (no double submits).
 * Every domain permission check (own draft claim, manager of the employee)
 * still runs on confirm.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { addExpenses, createClaim, decideClaim, getClaim, submitClaim, type ExpenseInputRaw } from '../domain/claims.js';
import { DomainError } from '../domain/errors.js';
import { appUrl } from '../config.js';
import type { Actor } from './interpret.js';
import { nonceUsed, recordEvent, type Channel } from './events.js';

export type AssistantAction =
  | { kind: 'add_expense'; claimId: string | null; newClaimTitle?: string; expense: ExpenseInputRaw }
  | { kind: 'decide'; claimId: string; approve: boolean; note?: string }
  | { kind: 'submit'; claimId: string };

interface Envelope {
  a: AssistantAction;
  u: string; // user id
  n: string; // nonce
  x: number; // expiry, ms since epoch
}

const TTL_MS = 15 * 60 * 1000;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

function mac(payload: string): string {
  return createHmac('sha256', secret()).update(`assistant-action:${payload}`).digest('base64url');
}

export function signAction(action: AssistantAction, userId: string, now = Date.now()): string {
  const env: Envelope = { a: action, u: userId, n: randomUUID(), x: now + TTL_MS };
  const payload = Buffer.from(JSON.stringify(env)).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

export function verifyAction(
  token: string,
  userId: string,
  now = Date.now(),
): { action: AssistantAction; nonce: string } {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) throw new DomainError('This confirmation is not valid.', 'invalid');
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new DomainError('This confirmation is not valid.', 'invalid');
  }
  const env = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Envelope;
  if (env.u !== userId) throw new DomainError('This confirmation belongs to someone else.', 'forbidden');
  if (env.x < now) throw new DomainError('This preview has expired. Please ask again.', 'invalid');
  return { action: env.a, nonce: env.n };
}

export interface ConfirmResult {
  reply: string;
  url: string;
  /** Suggested next steps, shown as chips. */
  options?: string[];
}

export async function confirmAction(user: Actor, token: string, channel: Channel): Promise<ConfirmResult> {
  const { action, nonce } = verifyAction(token, user.id);
  if (await nonceUsed(user.orgId, nonce)) throw new DomainError('This was already saved.', 'conflict');

  let result: ConfirmResult;
  let summary: string;

  if (action.kind === 'add_expense') {
    if (action.claimId) {
      await addExpenses(action.claimId, user.id, [action.expense], 'web');
      result = {
        reply: 'Saved to your draft claim.',
        url: `${appUrl()}/claims/${action.claimId}`,
        options: ['Submit it for approval', 'Add another expense'],
      };
    } else {
      const created = await createClaim(
        user.id,
        user.orgId,
        { title: action.newClaimTitle ?? 'Expenses', expenses: [action.expense] },
        'web',
      );
      result = {
        reply: 'Saved in a new draft claim.',
        url: created.appUrl,
        options: ['Submit it for approval', 'Add another expense'],
      };
    }
    summary = `add expense ${action.expense.category} ${action.expense.amount}`;
  } else if (action.kind === 'submit') {
    const r = await submitClaim(action.claimId, user.id, 'web');
    result = {
      reply: `Submitted for approval${r.approverName ? ` to ${r.approverName}` : ''}.`,
      url: `${appUrl()}/claims/${action.claimId}`,
    };
    summary = 'submit claim';
  } else {
    if (action.approve) {
      await decideClaim(action.claimId, user.id, [], true, action.note, 'web');
      result = { reply: 'Claim approved.', url: `${appUrl()}/claims/${action.claimId}` };
    } else {
      const claim = await getClaim(action.claimId, user.id);
      const note = action.note?.trim();
      if (!note) throw new DomainError('A reason is needed to reject a claim.', 'invalid');
      await decideClaim(
        action.claimId,
        user.id,
        claim.expenses.map((e) => ({ expenseId: e.id, approve: false, note })),
        false,
        note,
        'web',
      );
      result = { reply: 'Claim rejected.', url: `${appUrl()}/claims/${action.claimId}` };
    }
    summary = `${action.approve ? 'approve' : 'reject'} claim`;
  }

  await recordEvent({
    orgId: user.orgId,
    userId: user.id,
    channel,
    intent:
      action.kind === 'add_expense'
        ? 'log_expense'
        : action.kind === 'submit'
          ? 'submit_claim'
          : action.approve
            ? 'approve_claim'
            : 'reject_claim',
    outcome: 'confirmed',
    text: summary,
    meta: { nonce, claimId: action.claimId },
  });
  return result;
}
