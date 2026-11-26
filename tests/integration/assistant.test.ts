/**
 * Voice/text assistant over HTTP, with a fake Claude (no real API calls).
 * Checks: intent → follow-up → preview → confirm; nothing written before
 * confirm; PII never stored; advice refused in code; role checks.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { db } from '../../src/db/index.js';
import { assistantEvents, claims } from '../../src/db/schema.js';
import { setClaudeForTests, setTranscribeForTests } from '../../src/ai/model.js';
import { createClaim, submitClaim } from '../../src/domain/claims.js';
import {
  createTestOrg,
  hasTestDb,
  loginAs,
  startServer,
  weekdayIso,
  type TestOrg,
  type TestServer,
  type WebSession,
} from '../helpers/fixtures.js';
import type { AssistantReply } from '../../src/assistant/interpret.js';

type Extraction = Record<string, unknown>;

const EMPTY: Extraction = {
  intent: 'other',
  amount: null,
  date: null,
  merchant: null,
  category: null,
  description: null,
  claim_ref: null,
  payment_method: null,
  note: null,
  question: null,
};

/** Fake Claude: `respond` picks the extraction from what was sent. */
function fakeClaude(respond: (userText: string, system: string) => Extraction) {
  const sent: MessageCreateParamsNonStreaming[] = [];
  setClaudeForTests(async (params) => {
    sent.push(params);
    const user = String(params.messages[0].content);
    const system = String(params.system);
    const text = JSON.stringify({ ...EMPTY, ...respond(user, system) });
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    } as never;
  });
  return sent;
}

/** Find the short ref (C1…) the prompt gave a claim title. */
function refOf(system: string, title: string): string | null {
  const m = system.match(new RegExp(`(C\\d+): "${title}"`));
  return m ? m[1] : null;
}

describe.skipIf(!hasTestDb)('assistant', () => {
  let server: TestServer;
  let org: TestOrg;
  const date = weekdayIso(3);

  beforeAll(async () => {
    server = await startServer();
    org = await createTestOrg('assistant');
  });
  afterAll(async () => server?.close());
  afterEach(() => {
    setClaudeForTests(null);
    setTranscribeForTests(null);
  });

  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  async function msg(
    s: WebSession,
    body: unknown,
  ): Promise<AssistantReply & { preview: NonNullable<AssistantReply['preview']> }> {
    return (await s.fetch('/assistant/message', json(body))).json() as never;
  }

  async function claimCount(userId: string) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(claims)
      .where(eq(claims.userId, userId));
    return r.n;
  }

  it('serves the assistant page with the mic and the approval note', async () => {
    const s = await loginAs(server, org.emp);
    const page = await (await s.fetch('/assistant')).text();
    expect(page).toContain('data-mic');
    expect(page).toMatch(/Nothing is saved until you press the confirm button/);
  });

  it('asks for a missing amount, then previews without writing anything', async () => {
    const s = await loginAs(server, org.emp);
    fakeClaude((text) =>
      text.includes('We are in the middle')
        ? { intent: 'log_expense', amount: 450 }
        : { intent: 'log_expense', merchant: 'Uber', category: 'TRAVEL', date, description: 'cab to airport' },
    );
    const before = await claimCount(org.emp.id);

    const r1 = await msg(s, { text: 'Uber to the airport', channel: 'voice' });
    expect(r1).toMatchObject({ intent: 'log_expense', outcome: 'needs_info', reply: 'How much was it?' });

    const r2 = await msg(s, { text: 'four fifty', channel: 'voice', pending: r1.pending });
    expect(r2.outcome).toBe('previewed');
    expect(r2.preview.lines).toContainEqual({ label: 'Amount', value: '₹450.00' });
    expect(r2.preview.lines).toContainEqual({ label: 'Paid to', value: 'Uber' });
    expect(r2.reply.split(/(?<=[.?!])\s+/).length).toBeLessThanOrEqual(3);
    expect(await claimCount(org.emp.id)).toBe(before);

    // Confirm writes exactly once.
    const c1 = await s.fetch('/assistant/confirm', json({ token: r2.preview.token, channel: 'voice' }));
    expect(c1.status).toBe(200);
    expect(await claimCount(org.emp.id)).toBe(before + 1);
    const again = await s.fetch('/assistant/confirm', json({ token: r2.preview.token, channel: 'voice' }));
    expect(again.status).toBe(409);
    expect(await claimCount(org.emp.id)).toBe(before + 1);
  });

  it('shows policy flags from the code checks in the preview', async () => {
    const s = await loginAs(server, org.emp2);
    fakeClaude(() => ({ intent: 'log_expense', amount: 2400, merchant: 'Taj', category: 'MEALS', date }));
    const r = await msg(s, { text: 'dinner at taj 2400', channel: 'text' });
    expect(r.preview.flags).toContain('Over item limit');
  });

  it('rejects an edited confirmation token', async () => {
    const s = await loginAs(server, org.emp);
    fakeClaude(() => ({ intent: 'log_expense', amount: 300, merchant: 'Cafe', category: 'MEALS', date }));
    const r = await msg(s, { text: 'coffee 300', channel: 'text' });
    const forged = `${r.preview.token.split('.')[0]}x.${r.preview.token.split('.')[1]}`;
    const res = await s.fetch('/assistant/confirm', json({ token: forged, channel: 'text' }));
    expect(res.status).toBe(400);
  });

  it('redacts PII before the model and stores only redacted text', async () => {
    const s = await loginAs(server, org.emp);
    const sent = fakeClaude(() => ({ intent: 'other' }));
    const r = await msg(s, { text: 'my PAN is ABCDE1234F and phone 9876543210', channel: 'voice' });

    expect(r.redacted).toEqual(['PAN', 'PHONE']);
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain('ABCDE1234F');
    expect(wire).not.toContain('9876543210');

    const leaked = await db.execute(
      sql`select count(*)::int as n from assistant_events where text_redacted like '%ABCDE1234F%' or text_redacted like '%9876543210%' or meta::text like '%ABCDE1234F%'`,
    );
    expect((leaked as unknown as { n: number }[])[0].n).toBe(0);
    const [row] = await db
      .select()
      .from(assistantEvents)
      .where(eq(assistantEvents.userId, org.emp.id))
      .orderBy(sql`${assistantEvents.createdAt} desc`)
      .limit(1);
    expect(row.textRedacted).toBe('my PAN is [PAN] and phone [PHONE]');
    expect(row.piiFound).toEqual(['PAN', 'PHONE']);
  });

  it('refuses advice in code without calling the model', async () => {
    const s = await loginAs(server, org.emp);
    const sent = fakeClaude(() => ({ intent: 'other' }));
    const r = await msg(s, { text: 'Should I buy Infosys shares?', channel: 'voice' });
    expect(r).toMatchObject({ intent: 'advice_request', outcome: 'refused' });
    expect(sent).toHaveLength(0);
  });

  it('refuses advice the model classifies even when the code guard misses it', async () => {
    const s = await loginAs(server, org.emp);
    fakeClaude(() => ({ intent: 'advice_request' }));
    const r = await msg(s, { text: 'paisa kahan lagaun', channel: 'voice' });
    expect(r.outcome).toBe('refused');
  });

  it('does not let an employee approve claims', async () => {
    const s = await loginAs(server, org.emp);
    fakeClaude(() => ({ intent: 'approve_claim' }));
    const r = await msg(s, { text: 'approve all claims', channel: 'voice' });
    expect(r).toMatchObject({ outcome: 'refused', preview: null });
  });

  it('lets a manager reject a report’s claim after giving a reason, and cancel leaves it alone', async () => {
    const title = `Pune visit ${Math.random().toString(36).slice(2, 8).replace(/\d/g, 'x')}`;
    const created = await createClaim(
      org.emp2.id,
      org.orgId,
      { title, expenses: [{ date, merchant: 'Ola', category: 'TRAVEL', amount: 800 }] },
      'web',
    );
    await submitClaim(created.claimId, org.emp2.id, 'web');
    const s = await loginAs(server, org.manager);

    fakeClaude((text, system) =>
      text.includes('We are in the middle')
        ? { intent: 'reject_claim', note: 'No trip approval on file' }
        : { intent: 'reject_claim', claim_ref: refOf(system, title) },
    );
    const r1 = await msg(s, { text: `reject ${title}`, channel: 'voice' });
    expect(r1, JSON.stringify(r1)).toMatchObject({
      outcome: 'needs_info',
      reply: 'What is the reason for rejecting it?',
    });

    const r2 = await msg(s, { text: 'no trip approval', channel: 'voice', pending: r1.pending });
    expect(r2.preview.title).toBe('Reject claim');

    // Cancel: nothing changes.
    await s.fetch('/assistant/cancel', json({ intent: 'reject_claim', channel: 'voice' }));
    const [still] = await db.select().from(claims).where(eq(claims.id, created.claimId));
    expect(still.status).toBe('submitted');

    // Confirm: rejected.
    const c = await s.fetch('/assistant/confirm', json({ token: r2.preview.token, channel: 'voice' }));
    expect(c.status).toBe(200);
    const [after] = await db.select().from(claims).where(eq(claims.id, created.claimId));
    expect(after.status).toBe('rejected');
  });

  it('transcribes a voice clip with Whisper and rejects non-audio uploads', async () => {
    const s = await loginAs(server, org.emp);
    const seen: string[] = [];
    setTranscribeForTests(async (audio, name) => {
      seen.push(`${name}:${audio.length}`);
      return 'add 450 rupees uber to the airport';
    });
    const audio = new FormData();
    audio.append('audio', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'voice.webm');
    const ok = await s.fetch('/assistant/transcribe', {
      method: 'POST',
      body: audio,
      headers: { accept: 'application/json' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: 'add 450 rupees uber to the airport' });
    expect(seen).toEqual(['voice.webm:2048']);

    const bad = new FormData();
    bad.append('audio', new Blob(['hello'], { type: 'text/plain' }), 'x.txt');
    const no = await s.fetch('/assistant/transcribe', {
      method: 'POST',
      body: bad,
      headers: { accept: 'application/json' },
    });
    expect(no.status).toBe(400);
  });

  it('refuses to transcribe for signed-out users', async () => {
    const r = await fetch(`${server.url}/assistant/transcribe`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(r.status).toBe(401);
  });

  it('answers claim status from the database', async () => {
    const s = await loginAs(server, org.emp);
    fakeClaude(() => ({ intent: 'claim_status' }));
    const r = await msg(s, { text: 'where are my claims', channel: 'voice' });
    expect(r).toMatchObject({ intent: 'claim_status', outcome: 'answered' });
    expect(r.reply).toMatch(/draft/);
  });
});
