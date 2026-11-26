/**
 * The response desk: three agents in parallel, the orchestrator, the reviewer,
 * and the human gate. State is diffed before and after each decision.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { setClaudeForTests } from '../../src/ai/model.js';
import { db } from '../../src/db/index.js';
import { canonicalAnswers, replyDrafts } from '../../src/db/schema.js';
import { interpret } from '../../src/assistant/interpret.js';
import {
  approveDraft,
  editDraft,
  fixedDrafter,
  myQuestions,
  rejectDraft,
  submitQuestion,
  type AgentTrace,
  type Routing,
} from '../../src/desk/desk.js';
import type { Review } from '../../src/desk/reviewer.js';
import { createTestOrg, hasTestDb, loginAs, startServer, type TestOrg, type TestServer } from '../helpers/fixtures.js';

/** Fake model: intent extraction, drafter and reviewer each answered from the system prompt. */
function fakeModel(h: { question?: string; answer?: object; review?: object }) {
  setClaudeForTests(async (params) => {
    const system = String(params.system);
    const body = system.includes('reviewer on a finance support desk')
      ? (h.review ?? { supported: true, issue: '' })
      : system.includes("answer employees' questions")
        ? (h.answer ?? { covered: false, answer: '', passage_ids: [] })
        : {
            intent: 'policy_question',
            amount: null,
            date: null,
            merchant: null,
            category: null,
            description: null,
            claim_ref: null,
            payment_method: null,
            note: null,
            question: h.question ?? null,
          };
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: JSON.stringify(body), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    } as never;
  });
}

async function rows(orgId: string) {
  const r = await db.select().from(replyDrafts).where(eq(replyDrafts.orgId, orgId));
  return Object.fromEntries(r.map((x) => [x.id, `${x.status}|${x.edited}|${x.draft}|${x.finalReply ?? ''}`]));
}
const changed = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);

describe.skipIf(!hasTestDb)('response desk', () => {
  let org: TestOrg;
  let server: TestServer;

  beforeAll(async () => {
    org = await createTestOrg('desk');
    server = await startServer();
  });
  afterAll(async () => server?.close());
  afterEach(() => setClaudeForTests(null));

  it('queues a question with three agents, a routing note and a review; the asker sees no facts until approval', async () => {
    fakeModel({
      question: 'What is the lodging limit?',
      answer: { covered: true, answer: 'Lodging has a per-item limit of ₹6,000.00.', passage_ids: ['policy-limit-lodge'] },
    });
    const r = await interpret({ user: org.emp, text: 'hotel limit kitna hai', channel: 'voice' });
    expect(r.outcome).toBe('queued');
    expect(r.reply).not.toMatch(/6,000/);
    expect(r.policy?.sources).toEqual([]);
    expect(r.policy?.queued?.id).toBeTruthy();

    const [row] = await db.select().from(replyDrafts).where(eq(replyDrafts.id, r.policy!.queued!.id));
    expect(row.status).toBe('pending');
    expect(row.draft).toBe('Lodging has a per-item limit of ₹6,000.00.');
    expect(row.sources[0].passageId).toBe('policy-limit-lodge');
    expect((row.agents as unknown as AgentTrace[]).map((a) => a.agent)).toEqual(['corpus', 'signals', 'compliance']);
    expect((row.routing as unknown as Routing).note).toMatch(/Lodging limits\. Asked \d+ times? in the last 7 days/);
    const rev = row.review as unknown as Review;
    expect(rev.verdict).toBe('pass');
    expect(rev.model).toBe('supported');

    const mine = await myQuestions(org.emp);
    expect(mine[0]).toMatchObject({ status: 'in_review', reply: null, sources: [] });
  });

  it('the reviewer rejects an invented figure; approval is blocked until an edit passes the same checks', async () => {
    const out = await submitQuestion(
      org.emp,
      { question: 'What is the hotel limit per night?', channel: 'text', via: 'web' },
      { drafter: fixedDrafter('Hotel stays are reimbursed up to ₹8,000 per night.', ['policy-limit-lodge']), modelReview: false },
    );
    if (out.kind !== 'queued') throw new Error('expected a queued draft');
    expect(out.review.verdict).toBe('reject');
    expect(out.review.flags.find((f) => f.code === 'ungrounded_number')?.message).toMatch(/8000/);
    await expect(approveDraft(org.orgId, out.draftId, org.admin.id)).rejects.toThrow(/reviewer rejected/);

    // An edit that still invents a number is refused, and the draft is unchanged.
    await expect(editDraft(org.orgId, out.draftId, 'The limit is ₹7,500 per night.')).rejects.toThrow(/not in the cited/);
    const [still] = await db.select().from(replyDrafts).where(eq(replyDrafts.id, out.draftId));
    expect(still.edited).toBe(false);

    const before = await rows(org.orgId);
    await editDraft(org.orgId, out.draftId, 'Lodging has a per-item limit of ₹6,000.00 and no daily limit.');
    expect(changed(before, await rows(org.orgId))).toEqual([out.draftId]);

    const ok = await approveDraft(org.orgId, out.draftId, org.admin.id);
    expect(ok.finalReply).toBe('Lodging has a per-item limit of ₹6,000.00 and no daily limit.');
    const mine = (await myQuestions(org.emp)).find((q) => q.id === out.draftId)!;
    expect(mine.status).toBe('answered');
    expect(mine.sources[0].url).toBeTruthy();
  });

  it('approving or rejecting one draft changes only that draft, and a decided draft cannot be decided again', async () => {
    const make = (q: string) =>
      submitQuestion(
        org.emp2,
        { question: q, channel: 'text', via: 'web' },
        { drafter: fixedDrafter('Expenses dated on a Saturday or Sunday are allowed but flagged for the approver to check.', ['policy-weekend']), modelReview: false },
      );
    const a = await make('Can I claim a cab on Sunday?');
    const b = await make('Are weekend expenses allowed?');
    if (a.kind !== 'queued' || b.kind !== 'queued') throw new Error('expected queued drafts');

    let before = await rows(org.orgId);
    await approveDraft(org.orgId, a.draftId, org.admin.id);
    expect(changed(before, await rows(org.orgId))).toEqual([a.draftId]);
    await expect(approveDraft(org.orgId, a.draftId, org.admin.id)).rejects.toThrow(/already decided/);

    before = await rows(org.orgId);
    await rejectDraft(org.orgId, b.draftId, org.admin.id, 'Ask your manager; call me on 9876543210.');
    expect(changed(before, await rows(org.orgId))).toEqual([b.draftId]);
    const [rb] = await db.select().from(replyDrafts).where(eq(replyDrafts.id, b.draftId));
    expect(rb.rejectReason).not.toMatch(/9876543210/);
    await expect(rejectDraft(org.orgId, b.draftId, org.admin.id)).rejects.toThrow(/already decided/);
  });

  it('a model reviewer objection only flags the draft; it does not block it', async () => {
    fakeModel({
      answer: { covered: true, answer: 'A receipt image is required for any expense above ₹500.00.', passage_ids: ['policy-receipts'] },
      review: { supported: false, issue: 'Says nothing about when the claim is flagged.' },
    });
    const out = await submitQuestion(org.emp, { question: 'When do I need a receipt?', channel: 'text', via: 'web' });
    if (out.kind !== 'queued') throw new Error('expected a queued draft');
    expect(out.review.verdict).toBe('flag');
    expect(out.review.model).toBe('unsupported');
    await approveDraft(org.orgId, out.draftId, org.admin.id); // a person may still approve it
  });

  it('removes personal data before anything is stored, and says so to the reviewer', async () => {
    const out = await submitQuestion(
      org.emp,
      { question: 'My PAN is ABCDE1234F, what is the meals limit?', channel: 'voice', via: 'web' },
      { drafter: fixedDrafter('Meals (MEALS): per-item limit ₹1,500.00; daily limit ₹2,500.00.', ['policy-limit-meals']), modelReview: false },
    );
    if (out.kind !== 'queued') throw new Error('expected a queued draft');
    const [row] = await db.select().from(replyDrafts).where(eq(replyDrafts.id, out.draftId));
    expect(JSON.stringify(row)).not.toMatch(/ABCDE1234F/);
    expect(row.question).toMatch(/\[PAN\]/);
    expect((row.review as unknown as Review).flags.some((f) => f.code === 'pii_removed')).toBe(true);
  });

  it('an approved canonical answer skips the queue', async () => {
    await db.insert(canonicalAnswers).values({
      id: randomUUID(),
      orgId: org.orgId,
      topic: 'policy-gstin',
      title: 'Supplier GSTIN',
      bullets: [{ text: "The supplier's GSTIN is required for any expense above ₹2,000.00", passageId: 'policy-gstin' }],
      sources: [{ title: 'Expense policy', url: 'https://example.test/policy', lastChecked: '2026-11-26' }],
      lastChecked: '2026-11-26',
    });
    const before = await rows(org.orgId);
    const out = await submitQuestion(org.emp, { question: 'Which bills need a GSTIN?', channel: 'text', via: 'web' });
    expect(out.kind).toBe('canonical');
    expect(changed(before, await rows(org.orgId))).toEqual([]);
  });

  it('shows the queue to admins only, and approves from the page', async () => {
    const out = await submitQuestion(
      org.emp,
      { question: 'What is the leave policy?', channel: 'text', via: 'web' },
      { drafter: fixedDrafter(null), modelReview: false },
    );
    if (out.kind !== 'queued') throw new Error('expected a queued draft');
    const emp = await loginAs(server, org.emp);
    expect((await emp.fetch('/desk')).status).toBe(403);

    const admin = await loginAs(server, org.admin);
    const html = await (await admin.fetch('/desk')).text();
    expect(html).toContain('What is the leave policy?');
    expect(html).toMatch(/Approving a draft writes one thing/);
    expect(html).toMatch(/Agents \(run in parallel\)/);
    const res = await admin.post(`/desk/drafts/${out.draftId}/approve`, {});
    expect(res.status).toBe(303);
    const mine = (await myQuestions(org.emp)).find((q) => q.id === out.draftId)!;
    expect(mine.status).toBe('answered');
    expect(mine.reply).toMatch(/couldn't find this/);
  });
});
