import { describe, expect, it } from 'vitest';
import { signAction, verifyAction, type AssistantAction } from '../../src/assistant/actions.js';
import { DomainError } from '../../src/domain/errors.js';

const action: AssistantAction = {
  kind: 'add_expense',
  claimId: null,
  newClaimTitle: 'Expenses Nov 2026',
  expense: { date: '2026-11-20', merchant: 'Uber', category: 'TRAVEL', amount: 450 },
};

describe('signed assistant actions (approval gate)', () => {
  it('round-trips the exact previewed action', () => {
    const token = signAction(action, 'user-1');
    expect(verifyAction(token, 'user-1').action).toEqual(action);
  });

  it('rejects a token whose action was edited', () => {
    const token = signAction(action, 'user-1');
    const [payload, sig] = token.split('.');
    const env = JSON.parse(Buffer.from(payload, 'base64url').toString());
    env.a.expense.amount = 45000;
    const forged = `${Buffer.from(JSON.stringify(env)).toString('base64url')}.${sig}`;
    expect(() => verifyAction(forged, 'user-1')).toThrow(DomainError);
  });

  it('rejects a token used by a different user', () => {
    const token = signAction(action, 'user-1');
    expect(() => verifyAction(token, 'user-2')).toThrow(/someone else/);
  });

  it('rejects an expired token', () => {
    const token = signAction(action, 'user-1', Date.now() - 16 * 60 * 1000);
    expect(() => verifyAction(token, 'user-1')).toThrow(/expired/);
  });

  it('rejects garbage', () => {
    expect(() => verifyAction('nope', 'user-1')).toThrow(DomainError);
  });
});
