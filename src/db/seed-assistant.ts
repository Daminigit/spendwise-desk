/**
 * src/db/seed-assistant.ts
 *
 * Demo assistant history for the last 7 days, so the weekly loop has
 * something to group on a fresh deployment. The questions contain no PII.
 * Each one is routed exactly as the live assistant would route it (same
 * corpus search), so its topic and outcome are real, not hand-labelled.
 */

import { randomUUID } from 'crypto';
import { db } from './index.js';
import { assistantEvents } from './schema.js';
import { loadCorpus } from '../corpus/corpus.js';
import { search } from '../corpus/search.js';
import { isAdviceRequest } from '../assistant/guard.js';
import { createClaim } from '../domain/claims.js';
import { approveDraft, fixedDrafter, submitQuestion } from '../desk/desk.js';
import { findUserById } from '../domain/org.js';

/** YYYY-MM-DD in India, `daysAgo` days back. */
function istDay(daysAgo: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() - daysAgo * 86_400_000),
  );
}

/** A weekday (Mon–Fri) and a Saturday inside the last 7 days. */
function recentDays(): { weekday: string[]; saturday: string } {
  const days = [1, 2, 3, 4, 5, 6].map(istDay);
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  return {
    weekday: days.filter((d) => dow(d) >= 1 && dow(d) <= 5),
    saturday: days.find((d) => dow(d) === 6) ?? days[0],
  };
}

/**
 * This week's draft claim, built through the real createClaim so the policy
 * checks raise real flags: missing GSTIN, over the meals limit, weekend.
 */
export async function seedRecentClaim(orgId: string, userId: string): Promise<string> {
  const { weekday, saturday } = recentDays();
  const d1 = weekday[0] ?? saturday;
  const d2 = weekday[1] ?? d1;
  const res = await createClaim(
    userId,
    orgId,
    {
      title: 'Hyderabad vendor visit',
      purpose: 'Vendor audit',
      expenses: [
        {
          date: d1,
          merchant: 'Hotel Lakeview',
          category: 'LODGE',
          amount: 4800,
          description: '1 night, no GSTIN on bill',
        },
        { date: d1, merchant: 'Paradise Biryani', category: 'MEALS', amount: 2400, description: 'Team lunch' },
        { date: d2, merchant: 'Kamat Hotel', category: 'MEALS', amount: 2150, description: 'Working dinner' },
        { date: saturday, merchant: 'Uber', category: 'TRAVEL', amount: 650, description: 'Airport drop' },
      ],
    },
    'web',
  );
  return res.claimId;
}

/** [question, days ago]. Seven GSTIN questions → crosses the "asked 5+ times" rule. */
const QUESTIONS: [string, number][] = [
  ['Do I need the GSTIN on a hotel bill?', 6],
  ['is GSTIN mandatory for a 2500 rupee bill', 5],
  ['hotel ne GSTIN nahi diya, kya chalega?', 5],
  ['What happens if the supplier GSTIN is missing?', 4],
  ['Which bills need a GSTIN?', 3],
  ['my cab bill has no GSTIN, is that a problem', 2],
  ['GSTIN required above what amount?', 1],
  ['What is the hotel limit per night?', 6],
  ['how much can I spend on a hotel stay', 4],
  ['lodging limit kitna hai', 3],
  ['Is there a cap on hotel rooms?', 1],
  ['What is the daily meals limit?', 5],
  ['how much for dinner with the team', 2],
  ['Can I claim a cab on Sunday?', 3],
  ['are weekend expenses allowed', 1],
  ['When do I need to attach a receipt?', 2],
  ['Can I claim GST input credit on hotel food?', 4],
  ['Is gym membership reimbursable?', 2],
  ['What must a GST tax invoice show?', 3],
  ['Should I put my reimbursement into a mutual fund?', 2],
];

export async function seedAssistantEvents(orgId: string, userIds: string[]): Promise<number> {
  const { passages } = await loadCorpus(orgId);
  const rows: (typeof assistantEvents.$inferInsert)[] = [];
  const now = Date.now();

  QUESTIONS.forEach(([text, daysAgo], i) => {
    const createdAt = new Date(now - daysAgo * 86_400_000 - (i % 5) * 3_600_000);
    const userId = userIds[i % userIds.length];
    if (isAdviceRequest(text)) {
      rows.push({
        id: randomUUID(),
        orgId,
        userId,
        channel: 'voice',
        intent: 'advice_request',
        outcome: 'refused',
        textRedacted: text,
        createdAt,
      });
      return;
    }
    const { hits, terms } = search(passages, text);
    const topic = hits[0]?.passage.id ?? `uncovered:${[...terms].sort().slice(0, 4).join('+') || 'none'}`;
    rows.push({
      id: randomUUID(),
      orgId,
      userId,
      channel: i % 3 === 0 ? 'text' : 'voice',
      intent: 'policy_question',
      outcome: hits.length ? 'answered' : 'not_covered',
      textRedacted: text,
      meta: { topic, covered: hits.length > 0, sources: hits.slice(0, 1).map((h) => h.passage.url), demo: true },
      createdAt,
    });
  });

  // A few expenses logged by voice and confirmed.
  for (let d = 0; d < 6; d++) {
    rows.push({
      id: randomUUID(),
      orgId,
      userId: userIds[d % userIds.length],
      channel: 'voice',
      intent: 'log_expense',
      outcome: 'confirmed',
      textRedacted: 'add expense (demo)',
      meta: { demo: true },
      createdAt: new Date(now - d * 86_400_000),
    });
  }

  await db.insert(assistantEvents).values(rows);
  return rows.length;
}

/**
 * A demo queue on the response desk. The drafts are fixed (no model call at
 * boot), but each goes through the real agents, orchestrator and reviewer,
 * so the verdicts are real: the hotel-limit draft states ₹8,000, which is not
 * in the cited passage, and the reviewer rejects it.
 */
const DESK_DEMO: { q: string; reply: string | null; cite: string[]; approve?: boolean }[] = [
  {
    q: 'When do I need to attach a receipt?',
    reply: 'A receipt image is required for any expense above ₹500.00. A claim missing a required receipt is flagged when it is submitted.',
    cite: ['policy-receipts'],
    approve: true,
  },
  {
    q: 'Do I need the GSTIN on a hotel bill?',
    reply: "Yes, if the bill is above ₹2,000.00: the supplier's GSTIN is required for any expense above that amount. A missing or invalid GSTIN is flagged for the approver.",
    cite: ['policy-gstin'],
  },
  {
    q: 'What is the hotel limit per night?',
    reply: 'Hotel stays are reimbursed up to ₹8,000 per night.',
    cite: ['policy-limit-lodge'],
  },
  {
    q: 'Can I claim a cab on Sunday?',
    reply: 'Yes. Expenses dated on a Saturday or Sunday are allowed but flagged for the approver to check.',
    cite: ['policy-weekend'],
  },
  { q: 'What is the leave policy?', reply: null, cite: [] },
];

export async function seedReplyDrafts(orgId: string, askerIds: string[], adminId: string): Promise<number> {
  let n = 0;
  for (const [i, d] of DESK_DEMO.entries()) {
    const user = await findUserById(askerIds[i % askerIds.length]);
    if (!user || user.orgId !== orgId) continue;
    const out = await submitQuestion(
      user,
      { question: d.q, channel: i % 2 ? 'voice' : 'text', via: 'web' },
      { drafter: fixedDrafter(d.reply, d.cite), modelReview: false },
    );
    if (out.kind === 'queued') {
      n += 1;
      if (d.approve) await approveDraft(orgId, out.draftId, adminId);
    }
  }
  return n;
}
