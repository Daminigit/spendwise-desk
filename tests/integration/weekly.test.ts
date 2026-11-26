/**
 * Weekly loop + approval gate + the link between the two loops.
 *
 *   - feasibility: themes ≤5 with ids and a window, pulse ≤250 words,
 *     explainer ≤6 cited bullets, runs with no manual step (AI or no AI)
 *   - correctness of edits: an edit changes only that draft; approving one
 *     action writes only that action; rejecting leaves the rest untouched
 *     (state is diffed before and after each step)
 *   - connection: 5+ repeated questions from the response loop appear in the
 *     pulse; an approved explainer is reused by the response loop
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { db } from '../../src/db/index.js';
import { canonicalAnswers, publishedOutputs, runActions, weeklyRuns } from '../../src/db/schema.js';
import { setClaudeForTests } from '../../src/ai/claude.js';
import { seedAssistantEvents, seedRecentClaim } from '../../src/db/seed-assistant.js';
import { runWeeklyLoop, words, type Explainer, type Pulse, type Theme } from '../../src/pulse/weekly.js';
import { approveAction, editAction, rejectAction } from '../../src/pulse/approvals.js';
import { answerPolicyQuestion } from '../../src/assistant/policy.js';
import { interpret } from '../../src/assistant/interpret.js';
import { isRunTime } from '../../src/pulse/scheduler.js';
import { createTestOrg, hasTestDb, loginAs, startServer, type TestOrg, type TestServer } from '../helpers/fixtures.js';

/** Fake Claude that answers each purpose from the request's system prompt. */
function fakeClaude(handlers: { pulse?: object; explainer?: (prompt: string) => object; other?: object }) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  setClaudeForTests(async (params) => {
    calls.push(params);
    const system = String(params.system);
    const prompt = String(params.messages[0].content);
    const body = system.includes('weekly expense-policy pulse')
      ? (handlers.pulse ?? { summary: 'GSTIN questions led the week.', actions: ['a', 'b', 'c'] })
      : system.includes('facts-only explainer')
        ? (handlers.explainer?.(prompt) ?? { title: 't', bullets: [] })
        : system.includes("answer employees' questions")
          ? { covered: false, answer: '', passage_ids: [] }
          : (handlers.other ?? {});
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
  return calls;
}

async function snapshot(orgId: string) {
  const actions = await db.select().from(runActions).where(eq(runActions.orgId, orgId));
  const outputs = await db.select().from(publishedOutputs).where(eq(publishedOutputs.orgId, orgId));
  const canon = await db.select().from(canonicalAnswers).where(eq(canonicalAnswers.orgId, orgId));
  return {
    actions: Object.fromEntries(
      actions.map((a) => [a.id, { status: a.status, payload: JSON.stringify(a.payload), edited: a.edited }]),
    ),
    outputs: outputs.length,
    canonical: canon.length,
  };
}

describe.skipIf(!hasTestDb)('weekly loop', () => {
  let org: TestOrg;
  let server: TestServer;

  beforeAll(async () => {
    org = await createTestOrg('weekly');
    server = await startServer();
    await seedAssistantEvents(org.orgId, [org.emp.id, org.emp2.id]);
    await seedRecentClaim(org.orgId, org.emp.id);
  });
  afterAll(async () => server?.close());
  afterEach(() => setClaudeForTests(null));

  it('runs end to end with no AI configured, inside every cap, with traceable themes', async () => {
    const run = await runWeeklyLoop(org.orgId);
    const themes = run.themes as Theme[];
    const pulse = run.pulse as unknown as Pulse;
    const explainer = run.explainer as unknown as Explainer;

    expect(themes.length).toBeGreaterThan(0);
    expect(themes.length).toBeLessThanOrEqual(5);
    for (const t of themes) {
      expect(t.window).toMatch(/\d{4}$/);
      expect(t.eventIds).toHaveLength(t.questions); // every question count traces to an event id
      if (t.flags + t.rejections > 0) expect(t.expenseIds.length).toBeGreaterThan(0);
      expect(t.eventIds.length + t.expenseIds.length).toBeGreaterThan(0);
    }
    // The GSTIN theme joins questions (support) and flags (claims) on one source passage.
    const gstin = themes.find((t) => t.passageId === 'policy-gstin')!;
    expect(gstin.questions).toBeGreaterThanOrEqual(5);
    expect(gstin.flags).toBeGreaterThan(0);
    expect(gstin.repeated).toBe(true);

    expect(words(pulse.text)).toBeLessThanOrEqual(250);
    expect(pulse.text).toMatch(/Asked 5\+ times this week: Supplier GSTIN/);
    expect(pulse.actions).toHaveLength(3);

    expect(explainer.topic).toBe('policy-gstin');
    expect(explainer.bullets.length).toBeLessThanOrEqual(6);
    expect(explainer.sources.map((s) => s.url)).toContain('https://cbic-gst.gov.in/gst-invoice-rules.html');
    expect(explainer.sources).toHaveLength(2);
    expect(explainer.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Nothing written: three pending actions, no outputs, no canonical answer.
    const actions = await db.select().from(runActions).where(eq(runActions.runId, run.id));
    expect(actions.map((a) => a.kind).sort()).toEqual(['append_doc', 'email_draft', 'publish_explainer']);
    expect(actions.every((a) => a.status === 'pending')).toBe(true);
    expect((await snapshot(org.orgId)).outputs).toBe(0);
  });

  it('enforces the caps on whatever the model writes', async () => {
    fakeClaude({
      pulse: { summary: 'word '.repeat(400), actions: ['one', 'You should invest in index funds', 'three', 'four'] },
      explainer: (prompt) => ({
        title: 'GSTIN',
        bullets: [
          ...Array.from({ length: 8 }, (_, i) => ({ text: `Fact ${i}.`, passage_id: 'policy-gstin' })),
          { text: 'Made up.', passage_id: 'not-retrieved' },
        ].filter((b) => prompt.includes(`[${b.passage_id}]`) || b.passage_id === 'not-retrieved'),
      }),
    });
    const run = await runWeeklyLoop(org.orgId);
    const pulse = run.pulse as unknown as Pulse;
    const explainer = run.explainer as unknown as Explainer;
    expect(words(pulse.text)).toBeLessThanOrEqual(250);
    expect(pulse.actions).toHaveLength(3);
    expect(pulse.actions.join(' ')).not.toMatch(/invest/i);
    expect(explainer.bullets.length).toBeLessThanOrEqual(6);
    expect(explainer.bullets.every((b) => b.passageId !== 'not-retrieved')).toBe(true);
  });

  it('gate: edit changes only that draft; approve writes only that action; reject touches nothing else', async () => {
    const run = await runWeeklyLoop(org.orgId);
    const actions = await db.select().from(runActions).where(eq(runActions.runId, run.id));
    const doc = actions.find((a) => a.kind === 'append_doc')!;
    const email = actions.find((a) => a.kind === 'email_draft')!;
    const explainer = actions.find((a) => a.kind === 'publish_explainer')!;

    // Edit the email draft (with a phone number that must be redacted).
    const s0 = await snapshot(org.orgId);
    await editAction(org.orgId, email.id, 'Team, see the GSTIN explainer. Call 9876543210.', 'GSTIN this week');
    const s1 = await snapshot(org.orgId);
    for (const id of Object.keys(s0.actions)) {
      if (id === email.id) continue;
      expect(s1.actions[id]).toEqual(s0.actions[id]);
    }
    expect(s1.actions[email.id].edited).toBe(true);
    expect(s1.actions[email.id].payload).toContain('[PHONE]');
    expect(s1.outputs).toBe(s0.outputs);

    // Approve the doc entry: one output, everything else still pending.
    await approveAction(org.orgId, doc.id, org.admin.id);
    const s2 = await snapshot(org.orgId);
    expect(s2.outputs).toBe(s1.outputs + 1);
    expect(s2.canonical).toBe(s1.canonical);
    expect(s2.actions[email.id].status).toBe('pending');
    expect(s2.actions[explainer.id].status).toBe('pending');
    await expect(approveAction(org.orgId, doc.id, org.admin.id)).rejects.toThrow(/already decided/);

    // Reject the explainer: no canonical answer, nothing else changes.
    await rejectAction(org.orgId, explainer.id, org.admin.id);
    const s3 = await snapshot(org.orgId);
    expect(s3.canonical).toBe(s2.canonical);
    expect(s3.outputs).toBe(s2.outputs);
    expect(s3.actions[email.id]).toEqual(s2.actions[email.id]);

    // Approve the edited email: the written draft is the edited text.
    await approveAction(org.orgId, email.id, org.admin.id);
    const [out] = await db.select().from(publishedOutputs).where(eq(publishedOutputs.actionId, email.id));
    expect(out).toMatchObject({ kind: 'email_draft', title: 'GSTIN this week' });
    expect(out.body).toBe('Team, see the GSTIN explainer. Call [PHONE].');
  });

  it('connection: an approved explainer becomes the canonical answer the response loop reuses', async () => {
    const run = await runWeeklyLoop(org.orgId);
    const [publish] = await db
      .select()
      .from(runActions)
      .where(eq(runActions.runId, run.id))
      .then((rows) => rows.filter((a) => a.kind === 'publish_explainer'));
    await approveAction(org.orgId, publish.id, org.admin.id);

    const calls = fakeClaude({});
    const a = await answerPolicyQuestion(org.emp, 'Do I need a GSTIN on my hotel bill?');
    expect(a.canonical).not.toBeNull();
    expect(a.covered).toBe(true);
    expect(a.sources.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0); // reused, not drafted fresh

    const [canon] = await db.select().from(canonicalAnswers).where(eq(canonicalAnswers.id, a.canonical!.id));
    expect(canon.timesReused).toBe(1);

    // The next run notices it is already canonical and does not ask again.
    const next = await runWeeklyLoop(org.orgId);
    expect((next.explainer as unknown as Explainer).alreadyCanonical).toBe(true);
    const kinds = (await db.select().from(runActions).where(eq(runActions.runId, next.id))).map((x) => x.kind);
    expect(kinds).not.toContain('publish_explainer');
  });

  it('connection: the same question asked 5 times through the assistant shows up in the pulse', async () => {
    const fresh = await createTestOrg('weekly-link');
    fakeClaude({ other: { intent: 'policy_question', question: 'When is a receipt needed?' } });
    // The assistant drafts a policy answer each time (the extraction fake returns no answer → not covered is fine).
    for (const q of [
      'when do I need a receipt',
      'receipt needed for 600?',
      'do bills need receipts',
      'receipt rules?',
      'is a receipt required',
    ]) {
      await interpret({ user: fresh.emp, text: q, channel: 'voice' });
    }
    setClaudeForTests(null);
    const run = await runWeeklyLoop(fresh.orgId);
    const theme = (run.themes as Theme[]).find((t) => t.passageId === 'policy-receipts')!;
    expect(theme.questions).toBe(5);
    expect(theme.repeated).toBe(true);
    expect((run.pulse as unknown as Pulse).text).toMatch(/Asked 5\+ times this week: Receipts \(5\)/);
  });

  it('shows the pulse and approval screen to admins only', async () => {
    const admin = await loginAs(server, org.admin);
    const page = await (await admin.fetch('/pulse')).text();
    expect(page).toMatch(/Approvals/);
    expect(page).toMatch(/exactly what will be written and where/);
    const emp = await loginAs(server, org.emp);
    expect((await emp.fetch('/pulse')).status).toBe(403);
    const runs = await db.select().from(weeklyRuns).where(eq(weeklyRuns.orgId, org.orgId));
    expect(runs.length).toBeGreaterThan(0);
  });

  it('schedules for Monday 09:00 India time', () => {
    expect(isRunTime(new Date('2026-11-30T03:30:00Z'))).toBe(true); // Mon 09:00 IST
    expect(isRunTime(new Date('2026-11-30T03:00:00Z'))).toBe(false); // Mon 08:30 IST
    expect(isRunTime(new Date('2026-12-01T05:00:00Z'))).toBe(false); // Tuesday
  });
});
