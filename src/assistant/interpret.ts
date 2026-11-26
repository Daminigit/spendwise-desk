/**
 * src/assistant/interpret.ts
 *
 * Turns one spoken or typed message into an assistant reply.
 *
 *   message ──► code guard (advice / returns? refuse)
 *           ──► Claude: which intent + which details (JSON only, no prose)
 *           ──► code: validate every detail, ask for what is missing,
 *                     run policy checks, build a preview + signed action
 *
 * Claude never writes the reply text the user sees for actions, never decides
 * whether something passes policy, and never writes to the database. Nothing
 * is saved until the user confirms the preview (see actions.ts).
 */

import { askJson, AiUnavailableError } from '../ai/model.js';
import type { PiiKind } from '../ai/redact.js';
import {
  getClaim,
  listClaims,
  listPendingApprovals,
  previewExpenseFlags,
  type ClaimSummary,
  type ExpenseInputRaw,
} from '../domain/claims.js';
import { getPolicy } from '../domain/org.js';
import { formatINR, toPaise } from '../domain/money.js';
import type { Category, PaymentMethod, User } from '../db/schema.js';

/** The signed-in user (session shape, no password hash). */
export type Actor = Pick<User, 'id' | 'orgId' | 'role' | 'name'>;
import { FLAG_LABELS } from '../web/util.js';
import { ADVICE_REFUSAL, isAdviceRequest, violatesScope } from './guard.js';
import { signAction, type AssistantAction } from './actions.js';
import { recordEvent, type Channel, type Outcome } from './events.js';
import { answerPolicyQuestion, type PolicyAnswer } from './policy.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export const INTENTS = [
  'log_expense',
  'policy_question',
  'claim_status',
  'approve_claim',
  'reject_claim',
  'advice_request',
  'other',
] as const;
export type Intent = (typeof INTENTS)[number];

const PAYMENT_METHODS: PaymentMethod[] = ['personal_card', 'cash', 'upi', 'company_card'];

export interface ExpenseSlots {
  amount: number | null;
  date: string | null;
  merchant: string | null;
  category: string | null; // category code
  description: string | null;
  claim: string | null; // claim id, or 'new'
  payment_method: PaymentMethod | null;
}

/** Conversation state the browser sends back with the next message. */
export interface Pending {
  intent: 'log_expense' | 'approve_claim' | 'reject_claim';
  expense?: ExpenseSlots;
  claimId?: string | null;
  note?: string | null;
}

export interface Preview {
  title: string;
  lines: { label: string; value: string }[];
  flags: string[];
  confirmLabel: string;
  token: string;
}

export interface AssistantReply {
  intent: Intent;
  outcome: Outcome;
  reply: string;
  pending: Pending | null;
  options: string[];
  preview: Preview | null;
  policy: PolicyAnswer | null;
  /** PII kinds removed from the message before it was processed. */
  redacted: PiiKind[];
}

/** What the model returns. Every field is present; unknown values are null. */
interface Extraction {
  intent: Intent;
  amount: number | null;
  date: string | null;
  merchant: string | null;
  category: string | null;
  description: string | null;
  claim_ref: string | null;
  payment_method: PaymentMethod | null;
  note: string | null;
  question: string | null;
}

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({
  anyOf: [{ type, ...extra }, { type: 'null' }],
});

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'amount',
    'date',
    'merchant',
    'category',
    'description',
    'claim_ref',
    'payment_method',
    'note',
    'question',
  ],
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    amount: nullable('number'),
    date: nullable('string'),
    merchant: nullable('string'),
    category: nullable('string'),
    description: nullable('string'),
    claim_ref: nullable('string'),
    payment_method: nullable('string', { enum: PAYMENT_METHODS }),
    note: nullable('string'),
    question: nullable('string'),
  },
};

const MAX_AMOUNT_RUPEES = 500_000;

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface InterpretInput {
  user: Actor;
  text: string;
  channel: Channel;
  pending?: Pending | null;
  /** Injectable for tests; defaults to the real date in India. */
  today?: string;
}

export async function interpret(input: InterpretInput): Promise<AssistantReply> {
  const { user, channel } = input;
  const text = input.text.trim().slice(0, 1000);
  const today = input.today ?? todayInIndia();

  const finish = async (r: Omit<AssistantReply, 'redacted'>, redacted: PiiKind[] = []): Promise<AssistantReply> => {
    await recordEvent({
      orgId: user.orgId,
      userId: user.id,
      channel,
      intent: r.intent,
      outcome: r.outcome,
      text,
      meta: r.policy
        ? {
            covered: r.policy.covered,
            topic: r.policy.topic,
            canonicalId: r.policy.canonical?.id ?? null,
            sources: r.policy.sources.map((s) => s.url),
          }
        : undefined,
    });
    return { ...r, redacted };
  };

  if (!text) return blank('other', 'needs_info', 'I did not catch that. Could you say it again?');

  // 1. Scope guard, in code, before the model sees anything.
  if (isAdviceRequest(text)) {
    return finish(blank('advice_request', 'refused', ADVICE_REFUSAL));
  }

  // 2. Context the model needs to resolve "yesterday", "food", "the Bangalore claim".
  const ctx = await loadContext(user);

  // 3. Ask Claude for intent + details only.
  let extraction: Extraction;
  let redacted: PiiKind[];
  try {
    const res = await askJson<Extraction>({
      purpose: 'intent',
      system: buildSystemPrompt(user, ctx, today),
      prompt: buildUserPrompt(text, input.pending ?? null, ctx),
      effort: 'low',
      maxTokens: 4000,
      schema: EXTRACTION_SCHEMA,
    });
    if (res.refused) return finish(blank('other', 'refused', ADVICE_REFUSAL), res.redacted);
    extraction = res.value;
    redacted = res.redacted;
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      return blank(
        'other',
        'error',
        'The assistant is unavailable right now. You can still add expenses from My claims.',
      );
    }
    throw err;
  }

  // 4. A pending conversation keeps its intent when the reply is just an answer.
  let intent = extraction.intent;
  if (input.pending && (intent === 'other' || intent === input.pending.intent)) intent = input.pending.intent;

  let reply: Omit<AssistantReply, 'redacted'>;
  switch (intent) {
    case 'advice_request':
      reply = blank('advice_request', 'refused', ADVICE_REFUSAL);
      break;
    case 'log_expense':
      reply = await handleLogExpense(user, ctx, extraction, input.pending ?? null, today);
      break;
    case 'claim_status':
      reply = await handleStatus(user, ctx, extraction);
      break;
    case 'approve_claim':
    case 'reject_claim':
      reply = await handleDecision(user, ctx, intent, extraction, input.pending ?? null);
      break;
    case 'policy_question': {
      const answer = await answerPolicyQuestion(user, extraction.question || text);
      const safe = violatesScope(answer.reply) ? ADVICE_REFUSAL : answer.reply;
      reply = {
        ...blank('policy_question', answer.covered ? 'answered' : 'not_covered', safe),
        policy: { ...answer, reply: safe },
      };
      break;
    }
    default:
      reply = blank(
        'other',
        'answered',
        'I can log an expense, check a claim, or answer a policy question. For example: "Add 450 rupees Uber to the airport yesterday."',
      );
  }
  return finish(reply, redacted);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

interface Ctx {
  categories: Category[];
  drafts: ClaimSummary[];
  myClaims: ClaimSummary[];
  approvals: ClaimSummary[];
  /** Short refs (C1, C2…) the model sees instead of long ids. */
  refs: Map<string, string>;
}

async function loadContext(user: Actor): Promise<Ctx> {
  const { categories } = await getPolicy(user.orgId);
  const myClaims = (await listClaims(user.id)).slice(0, 15);
  const approvals = user.role === 'employee' ? [] : (await listPendingApprovals(user.id)).slice(0, 15);
  const refs = new Map<string, string>();
  [...myClaims, ...approvals].forEach((c) => {
    if (![...refs.values()].includes(c.id)) refs.set(`C${refs.size + 1}`, c.id);
  });
  return {
    categories: categories.filter((c) => c.active),
    drafts: myClaims.filter((c) => c.status === 'draft'),
    myClaims,
    approvals,
    refs,
  };
}

function refFor(ctx: Ctx, id: string): string {
  for (const [ref, v] of ctx.refs) if (v === id) return ref;
  return '?';
}

function buildSystemPrompt(user: Actor, ctx: Ctx, today: string): string {
  const cats = ctx.categories.map((c) => `${c.code}: ${c.name}`).join('\n');
  const mine = ctx.myClaims.map((c) => `${refFor(ctx, c.id)}: "${c.title}" (${c.status})`).join('\n') || 'none';
  const queue =
    ctx.approvals
      .map((c) => `${refFor(ctx, c.id)}: "${c.title}" by ${c.user?.name ?? 'employee'}, ${formatINR(c.totalMinor)}`)
      .join('\n') || 'none';

  return `You read messages sent to an expense-claims assistant for an Indian company and extract structured data. You never write replies to the user.

Today is ${today} (India). The user is a ${user.role}.

Intents:
- log_expense: the user wants to record something they spent.
- policy_question: a question about the company's expense rules, limits, GST or receipts.
- claim_status: asks about their own claims, or (manager/admin) what is waiting for approval.
- approve_claim / reject_claim: a manager or admin deciding a claim in the approval queue.
- advice_request: asks for investment, tax-planning, buy/sell, or returns advice. Always this intent for such requests, however phrased.
- other: anything else.

Rules for fields (use null when the message does not say it; never guess):
- amount: rupees as a number ("paanch sau" = 500, "1.2k" = 1200).
- date: YYYY-MM-DD. Resolve "today", "yesterday", "last Friday" from today's date.
- category: one code from the list below, or null if none clearly fits.
- merchant: the vendor or service (e.g. "Uber", "Taj Hotel").
- description: a few words on what it was for.
- claim_ref: a ref like C2 from the lists below, "new" if the user asks for a new claim, else null.
- note: for reject_claim, the reason given.
- question: for policy_question, the question restated in plain English.
Messages may be in English, Hindi or Hinglish. Text like [PAN] or [PHONE] was removed for privacy; ignore it.

Categories:
${cats}

The user's claims:
${mine}

Approval queue:
${queue}`;
}

function buildUserPrompt(text: string, pending: Pending | null, ctx: Ctx): string {
  if (!pending) return text;
  const state: Record<string, unknown> = { intent: pending.intent, ...(pending.expense ?? {}) };
  if (pending.claimId) state.claim_ref = refFor(ctx, pending.claimId);
  if (pending.expense?.claim)
    state.claim_ref = pending.expense.claim === 'new' ? 'new' : refFor(ctx, pending.expense.claim);
  delete state.claim;
  return `We are in the middle of this request (fields so far): ${JSON.stringify(state)}
The user's new message (it may just answer the missing field, or change a field):
${text}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// log_expense
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_SLOTS: ExpenseSlots = {
  amount: null,
  date: null,
  merchant: null,
  category: null,
  description: null,
  claim: null,
  payment_method: null,
};

async function handleLogExpense(
  user: Actor,
  ctx: Ctx,
  ex: Extraction,
  pending: Pending | null,
  today: string,
): Promise<Omit<AssistantReply, 'redacted'>> {
  const prev = pending?.intent === 'log_expense' ? (pending.expense ?? EMPTY_SLOTS) : EMPTY_SLOTS;
  const problems: string[] = [];

  // Merge: a new value wins over the old one; every value is checked in code.
  const slots: ExpenseSlots = { ...prev };

  if (ex.amount !== null) {
    if (Number.isFinite(ex.amount) && ex.amount > 0 && ex.amount <= MAX_AMOUNT_RUPEES) {
      slots.amount = Math.round(ex.amount * 100) / 100;
    } else {
      problems.push(`The amount should be between ₹1 and ${formatINR(toPaise(MAX_AMOUNT_RUPEES))}.`);
    }
  }
  if (ex.date !== null) {
    const d = checkDate(ex.date, today);
    if (d.ok) slots.date = ex.date;
    else problems.push(d.problem);
  }
  if (ex.category !== null) {
    const cat = ctx.categories.find(
      (c) => c.code.toUpperCase() === ex.category!.toUpperCase() || c.name.toUpperCase() === ex.category!.toUpperCase(),
    );
    if (cat) slots.category = cat.code;
  }
  if (ex.merchant?.trim()) slots.merchant = ex.merchant.trim().slice(0, 200);
  if (ex.description?.trim()) slots.description = ex.description.trim().slice(0, 500);
  if (ex.payment_method && PAYMENT_METHODS.includes(ex.payment_method)) slots.payment_method = ex.payment_method;
  if (ex.claim_ref) {
    if (ex.claim_ref.toLowerCase() === 'new') slots.claim = 'new';
    else {
      const id = ctx.refs.get(ex.claim_ref.toUpperCase());
      if (id && ctx.drafts.some((c) => c.id === id)) slots.claim = id;
      else if (id) problems.push('That claim is no longer a draft, so I can only add to a draft or a new claim.');
    }
  }
  // One draft: use it. No drafts: start a new one.
  if (!slots.claim && ctx.drafts.length === 1) slots.claim = ctx.drafts[0].id;
  if (!slots.claim && ctx.drafts.length === 0) slots.claim = 'new';

  const pendingNext: Pending = { intent: 'log_expense', expense: slots };
  const prefix = problems.length ? `${problems[0]} ` : '';

  // Ask for the first missing field, one at a time.
  if (slots.amount === null) return ask(pendingNext, `${prefix}How much was it?`);
  if (slots.category === null) {
    return ask(
      pendingNext,
      `${prefix}Which category is this?`,
      ctx.categories.map((c) => c.name),
    );
  }
  if (slots.date === null) return ask(pendingNext, `${prefix}Which date was it?`, ['Today', 'Yesterday']);
  if (slots.merchant === null) return ask(pendingNext, `${prefix}Who was it paid to?`);
  if (slots.claim === null) {
    return ask(pendingNext, `${prefix}Which claim should I add it to?`, [
      ...ctx.drafts.map((c) => c.title),
      'A new claim',
    ]);
  }

  // Everything is known: run the policy checks (code) and build the preview.
  const raw: ExpenseInputRaw = {
    date: slots.date,
    merchant: slots.merchant,
    category: slots.category,
    description: slots.description ?? '',
    amount: slots.amount,
    payment_method: slots.payment_method ?? 'personal_card',
  };
  const claimId = slots.claim === 'new' ? null : slots.claim;
  const { flags, category } = await previewExpenseFlags(user.id, user.orgId, claimId, raw);
  const claimTitle = claimId
    ? (ctx.drafts.find((c) => c.id === claimId)?.title ?? 'your draft claim')
    : newClaimTitle(slots.date);

  const action: AssistantAction = {
    kind: 'add_expense',
    claimId,
    newClaimTitle: claimId ? undefined : claimTitle,
    expense: raw,
  };
  const flagText = flags.map((f) => FLAG_LABELS[f] ?? f);
  const say =
    `${prefix}I'll add ${formatINR(toPaise(raw.amount))} for ${category.name} at ${raw.merchant} on ${prettyDate(raw.date)} ` +
    `to ${claimId ? `"${claimTitle}"` : `a new claim "${claimTitle}"`}.` +
    (flagText.length ? ` Policy check: ${flagText.join(', ').toLowerCase()}.` : ' No policy issues found.') +
    ' Shall I save it?';

  return {
    intent: 'log_expense',
    outcome: 'previewed',
    reply: say,
    pending: pendingNext,
    options: [],
    policy: null,
    preview: {
      title: 'Add expense',
      lines: [
        { label: 'Amount', value: formatINR(toPaise(raw.amount)) },
        { label: 'Category', value: category.name },
        { label: 'Date', value: prettyDate(raw.date) },
        { label: 'Paid to', value: raw.merchant },
        ...(raw.description ? [{ label: 'For', value: raw.description }] : []),
        { label: 'Claim', value: claimId ? claimTitle : `New: ${claimTitle}` },
      ],
      flags: flagText,
      confirmLabel: 'Save expense',
      token: signAction(action, user.id),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// claim_status
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_WORDS: Record<string, string> = {
  draft: 'a draft (not submitted yet)',
  submitted: 'submitted and waiting for approval',
  approved: 'approved',
  partially_approved: 'partly approved',
  rejected: 'rejected',
  paid: 'paid',
};

async function handleStatus(user: Actor, ctx: Ctx, ex: Extraction): Promise<Omit<AssistantReply, 'redacted'>> {
  const id = ex.claim_ref ? ctx.refs.get(ex.claim_ref.toUpperCase()) : undefined;
  const mine = id ? ctx.myClaims.find((c) => c.id === id) : undefined;

  if (mine) {
    return blank(
      'claim_status',
      'answered',
      `"${mine.title}" (${formatINR(mine.totalMinor)}) is ${STATUS_WORDS[mine.status]}.`,
    );
  }
  if (user.role !== 'employee' && (ctx.approvals.length > 0 || !ctx.myClaims.length)) {
    const n = ctx.approvals.length;
    if (n === 0) return blank('claim_status', 'answered', 'Nothing is waiting for your approval.');
    const first = ctx.approvals.slice(0, 2).map((c) => `"${c.title}" from ${c.user?.name ?? 'a team member'}`);
    return blank(
      'claim_status',
      'answered',
      `${n} claim${n === 1 ? ' is' : 's are'} waiting for your approval, including ${first.join(' and ')}.`,
    );
  }
  if (!ctx.myClaims.length) return blank('claim_status', 'answered', "You don't have any claims yet.");

  const latest = ctx.myClaims.slice(0, 3).map((c) => `"${c.title}" is ${STATUS_WORDS[c.status]}`);
  return blank('claim_status', 'answered', `${latest.join('; ')}.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// approve_claim / reject_claim
// ─────────────────────────────────────────────────────────────────────────────

async function handleDecision(
  user: Actor,
  ctx: Ctx,
  intent: 'approve_claim' | 'reject_claim',
  ex: Extraction,
  pending: Pending | null,
): Promise<Omit<AssistantReply, 'redacted'>> {
  if (user.role === 'employee') {
    return blank(intent, 'refused', 'Only managers and admins can approve or reject claims.');
  }
  const prevClaim = pending && pending.intent !== 'log_expense' ? pending.claimId : null;
  const refId = ex.claim_ref ? ctx.refs.get(ex.claim_ref.toUpperCase()) : undefined;
  const claimId = (refId && ctx.approvals.some((c) => c.id === refId) ? refId : null) ?? prevClaim ?? null;
  const note = ex.note?.trim() || (pending && pending.intent !== 'log_expense' ? pending.note : null) || null;
  const next: Pending = { intent, claimId, note };

  if (!ctx.approvals.length) return blank(intent, 'answered', 'Nothing is waiting for your approval.');
  if (!claimId) {
    return ask(
      next,
      `Which claim do you want to ${intent === 'approve_claim' ? 'approve' : 'reject'}?`,
      ctx.approvals.map((c) => `${c.title} (${c.user?.name ?? ''})`),
      intent,
    );
  }
  if (intent === 'reject_claim' && !note) return ask(next, 'What is the reason for rejecting it?', [], intent);

  const claim = await getClaim(claimId, user.id);
  const approve = intent === 'approve_claim';
  const action: AssistantAction = { kind: 'decide', claimId, approve, note: note ?? undefined };
  const flagged = claim.expenses.filter((e) => (e.flags as string[]).length > 0).length;

  return {
    intent,
    outcome: 'previewed',
    reply:
      `I'll ${approve ? 'approve' : 'reject'} all ${claim.expenses.length} line${claim.expenses.length === 1 ? '' : 's'} of ` +
      `"${claim.title}" from ${claim.user.name} (${formatINR(claim.totals.grossMinor)}).` +
      (flagged ? ` ${flagged} line${flagged === 1 ? ' has' : 's have'} policy flags.` : '') +
      ' Shall I go ahead?',
    pending: next,
    options: [],
    policy: null,
    preview: {
      title: approve ? 'Approve claim' : 'Reject claim',
      lines: [
        { label: 'Claim', value: claim.title },
        { label: 'Employee', value: claim.user.name },
        { label: 'Total', value: formatINR(claim.totals.grossMinor) },
        { label: 'Lines', value: String(claim.expenses.length) },
        ...(note ? [{ label: approve ? 'Note' : 'Reason', value: note }] : []),
      ],
      flags: flagged ? [`${flagged} flagged line${flagged === 1 ? '' : 's'}`] : [],
      confirmLabel: approve ? 'Approve claim' : 'Reject claim',
      token: signAction(action, user.id),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function blank(
  intent: Intent,
  outcome: Outcome,
  reply: string,
): Omit<AssistantReply, 'redacted'> & { redacted: PiiKind[] } {
  return { intent, outcome, reply, pending: null, options: [], preview: null, policy: null, redacted: [] };
}

function ask(pending: Pending, question: string, options: string[] = [], intent: Intent = pending.intent) {
  return { ...blank(intent, 'needs_info', question), pending, options };
}

export function todayInIndia(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

function checkDate(value: string, today: string): { ok: true } | { ok: false; problem: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    return { ok: false, problem: "I couldn't work out the date." };
  }
  if (value > today) return { ok: false, problem: 'That date is in the future.' };
  const yearAgo = new Date(`${today}T00:00:00Z`);
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  if (value < yearAgo.toISOString().slice(0, 10)) return { ok: false, problem: 'That date is more than a year ago.' };
  return { ok: true };
}

function prettyDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function newClaimTitle(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `Expenses ${d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}
