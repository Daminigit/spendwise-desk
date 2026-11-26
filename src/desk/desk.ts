/**
 * src/desk/desk.ts
 *
 * The response desk: every policy question, from the web assistant or from
 * the employee's own Claude (MCP ask_policy), comes through here.
 *
 *   question ──► three agents in parallel (src/desk/agents.ts)
 *                  corpus · signals · compliance
 *            ──► orchestrator: one draft + an internal routing note
 *            ──► reviewer (src/desk/reviewer.ts): code checks, then a model check
 *            ──► reply_drafts row, status "pending"
 *            ──► a person approves, edits or rejects it on /desk
 *            ──► only then does the employee see the reply
 *
 * Two kinds of question skip the queue, because a person already decided:
 *   - an approved canonical answer exists for the topic (approved on /pulse)
 *   - the question asks for advice or return figures (refused, fixed text)
 */

import { randomUUID } from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { replyDrafts, type ReplyDraft } from '../db/schema.js';
import { redactText } from '../ai/redact.js';
import { loadCorpus, type Passage } from '../corpus/corpus.js';
import { ADVICE_REFUSAL } from '../assistant/guard.js';
import { DomainError } from '../domain/errors.js';
import { draftPolicyAnswer, notCoveredReply, type PolicyAnswer, type PolicyDraft } from '../assistant/policy.js';
import { search } from '../corpus/search.js';
import type { Actor } from '../assistant/interpret.js';
import type { Channel } from '../assistant/events.js';
import { complianceScan, weekSignals, type Compliance, type Signals } from './agents.js';
import { codeChecks, review, verdictOf, MAX_SENTENCES, sentenceCount, type Review, type ReviewFlag } from './reviewer.js';

export interface Routing {
  destination: string;
  note: string;
  topic: string;
  topicLabel: string;
  askedThisWeek: number;
  repeated: boolean;
  flaggedLines: number;
}

export interface AgentTrace {
  agent: 'corpus' | 'signals' | 'compliance';
  ms: number;
  summary: string;
}

export type DeskOutcome =
  | { kind: 'refused'; reply: string }
  | { kind: 'canonical'; reply: string; answer: PolicyAnswer }
  | {
      kind: 'queued';
      reply: string;
      answer: PolicyAnswer;
      draftId: string;
      review: Review;
      routing: Routing;
    };

export interface SubmitInput {
  /** The question as the drafter should read it (may be the model's restatement). */
  question: string;
  /** The person's own words, before redaction; only used to spot what had to be removed. */
  raw?: string;
  channel: Channel;
  via: 'web' | 'mcp';
}

export interface SubmitOptions {
  /** Replace the corpus agent (seed data and evals plant known drafts through this). */
  drafter?: (user: Actor, question: string) => Promise<PolicyDraft>;
  /** Run the model reviewer (default: yes, when a model is configured). */
  modelReview?: boolean;
}

/**
 * A corpus agent that returns a fixed draft instead of asking the model, with
 * real retrieval around it. Used by the demo seed and the evals to plant
 * known drafts (including bad ones the reviewer must stop). `reply: null`
 * means "not covered".
 */
export function fixedDrafter(reply: string | null, passageIds: string[] = []) {
  return async (user: Actor, question: string): Promise<PolicyDraft> => {
    const { sources, passages } = await loadCorpus(user.orgId);
    const { hits, terms } = search(passages, question);
    const retrieved = hits.map((h) => h.passage);
    const all = new Map(passages.map((p) => [p.id, p]));
    const searched = [...sources.map((s) => s.title), ...(terms.length ? [`terms: ${terms.join(', ')}`] : [])];
    const topic = hits[0]?.passage.id ?? `uncovered:${[...terms].sort().slice(0, 4).join('+') || 'none'}`;
    const base = { searched, topic, retrieved, bestScore: hits[0]?.score ?? 0, canonical: null, trimmed: false };
    if (reply === null) {
      return { ...base, reply: notCoveredReply(sources.map((s) => s.title)), covered: false, sources: [], drafter: 'none', invalidCitations: [] };
    }
    const cited = passageIds.map((id) => all.get(id)).filter((p): p is Passage => Boolean(p));
    return {
      ...base,
      reply,
      covered: true,
      drafter: 'model',
      sources: cited.map((p) => ({ title: `${p.sourceTitle}: ${p.heading}`, url: p.url, lastChecked: p.lastChecked, passageId: p.id })),
      invalidCitations: passageIds.filter((id) => !retrieved.some((p) => p.id === id)),
    };
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

const sourceTitles = (searched: string[]) => searched.filter((s) => !s.startsWith('terms:'));

export async function submitQuestion(user: Actor, input: SubmitInput, opts: SubmitOptions = {}): Promise<DeskOutcome> {
  const question = redactText(input.question).trim().slice(0, 1000);
  const drafter = opts.drafter ?? draftPolicyAnswer;

  // 1. Three agents, in parallel.
  const [corpus, signals, compliance] = await Promise.all([
    timed(() => drafter(user, question)),
    timed(() => weekSignals(user.orgId, question)),
    timed(() => complianceScan(input.raw ?? input.question, question)),
  ]);
  const d = corpus.value;

  // Defence in depth: the guard upstream already refuses these.
  if (compliance.value.advice) return { kind: 'refused', reply: ADVICE_REFUSAL };

  // Already approved by a person on /pulse: reuse it.
  if (d.drafter === 'canonical') return { kind: 'canonical', reply: d.reply, answer: d };

  // 2. Orchestrator: one draft and a routing note from what the agents found.
  const routing = route(d, signals.value);
  const context = contextFlags(d, signals.value, compliance.value);
  const agents: AgentTrace[] = [
    { agent: 'corpus', ms: corpus.ms, summary: corpusSummary(d) },
    { agent: 'signals', ms: signals.ms, summary: signalsSummary(signals.value) },
    { agent: 'compliance', ms: compliance.ms, summary: complianceSummary(compliance.value) },
  ];

  // 3. Reviewer.
  const rev = await review(d, question, context, { model: opts.modelReview });

  const id = randomUUID();
  await db.insert(replyDrafts).values({
    id,
    orgId: user.orgId,
    userId: user.id,
    via: input.via,
    channel: input.channel,
    question,
    topic: d.topic,
    covered: d.covered,
    drafter: d.drafter,
    draft: redactText(d.reply),
    sources: d.sources,
    searched: d.searched,
    routing: { ...routing },
    review: { ...rev },
    agents: agents.map((a) => ({ ...a })),
  });

  const titles = sourceTitles(d.searched);
  const reply = d.covered
    ? `I've drafted an answer from ${d.sources[0]?.title.split(':')[0] ?? 'the sources'}. ` +
      `Finance checks every new answer before it is sent, so you'll see it under Your questions once it is approved.`
    : `I couldn't find this in the sources I have. I searched ${titles.join(' and ')}. ` +
      `I've passed your question to the finance desk.`;
  return { kind: 'queued', reply, answer: d, draftId: id, review: rev, routing };
}

function route(d: PolicyDraft, s: Signals): Routing {
  const destination = !d.covered
    ? 'Finance team: not covered by the sources'
    : d.topic.startsWith('cbic')
      ? 'Finance desk: GST invoice rules'
      : 'Finance desk: expense policy';
  const parts = [
    `${s.topicLabel}.`,
    `Asked ${s.askedThisWeek} time${s.askedThisWeek === 1 ? '' : 's'} in the last 7 days${s.repeated ? ' (5+: it will be in the weekly pulse)' : ''}.`,
  ];
  if (s.flaggedLines) {
    parts.push(
      `${s.flaggedLines} claim line${s.flaggedLines === 1 ? '' : 's'} flagged on this rule this week (${s.flagKinds.join(', ')}).`,
    );
  }
  if (!d.covered) parts.push('Answer it outside the desk, or add it to the policy notes so the corpus covers it.');
  else if (s.repeated) parts.push('No approved explainer yet: approving one on the pulse page would answer this automatically.');
  return {
    destination,
    note: parts.join(' '),
    topic: s.topic,
    topicLabel: s.topicLabel,
    askedThisWeek: s.askedThisWeek,
    repeated: s.repeated,
    flaggedLines: s.flaggedLines,
  };
}

/** What the signals and compliance agents add for the reviewer to show. */
function contextFlags(d: PolicyDraft, s: Signals, c: Compliance): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  if (!d.covered) {
    flags.push({ code: 'not_covered', severity: 'info', message: 'Not covered by the corpus; the reply says so and names what was searched.' });
  }
  if (c.piiFound.length) {
    flags.push({
      code: 'pii_removed',
      severity: 'info',
      message: `Removed from the question before anything was stored or drafted: ${c.piiFound.join(', ')}.`,
    });
  }
  if (c.scope) {
    flags.push({ code: 'question_scope', severity: 'warn', message: 'The question touches on advice or returns; make sure the reply stays factual.' });
  }
  if (d.covered && d.drafter === 'extractive') {
    flags.push({ code: 'extractive', severity: 'info', message: 'No model available: the draft quotes the passage word for word.' });
  }
  if (d.covered && s.repeated) {
    flags.push({ code: 'repeated', severity: 'info', message: `Asked ${s.askedThisWeek} times this week.` });
  }
  return flags;
}

function corpusSummary(d: PolicyDraft): string {
  const n = d.retrieved.length;
  if (!d.covered) return `${n} passage${n === 1 ? '' : 's'} retrieved; none answers the question.`;
  const by = d.drafter === 'model' ? 'model draft' : 'quoted the best passage';
  return `${n} passage${n === 1 ? '' : 's'} retrieved; ${by} citing ${d.sources.map((s) => s.passageId).join(', ') || 'nothing'}.`;
}

function signalsSummary(s: Signals): string {
  return `${s.askedThisWeek}× this week on ${s.topicLabel}; ${s.flaggedLines} flagged line${s.flaggedLines === 1 ? '' : 's'}${s.canonical ? '; canonical answer exists' : ''}.`;
}

function complianceSummary(c: Compliance): string {
  const bits = [
    c.piiFound.length ? `removed ${c.piiFound.join(', ')}` : 'no personal data',
    c.advice ? 'advice request' : 'no advice request',
  ];
  return `${bits.join('; ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The queue: list, approve, edit, reject. Each changes one row and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

export async function listDrafts(orgId: string, status: 'pending' | 'decided'): Promise<ReplyDraft[]> {
  if (status === 'pending') {
    return db
      .select()
      .from(replyDrafts)
      .where(and(eq(replyDrafts.orgId, orgId), eq(replyDrafts.status, 'pending')))
      .orderBy(asc(replyDrafts.createdAt));
  }
  const rows = await db
    .select()
    .from(replyDrafts)
    .where(eq(replyDrafts.orgId, orgId))
    .orderBy(desc(replyDrafts.decidedAt))
    .limit(100);
  return rows.filter((r) => r.status !== 'pending');
}

export async function countPending(orgId: string): Promise<number> {
  return (await listDrafts(orgId, 'pending')).length;
}

async function load(orgId: string, id: string): Promise<ReplyDraft> {
  const [r] = await db
    .select()
    .from(replyDrafts)
    .where(and(eq(replyDrafts.orgId, orgId), eq(replyDrafts.id, id)));
  if (!r) throw new DomainError('Draft not found.', 'not_found');
  return r;
}

const reviewOf = (r: ReplyDraft) => r.review as unknown as Review;

export async function approveDraft(orgId: string, id: string, actorId: string): Promise<ReplyDraft> {
  const r = await load(orgId, id);
  if (r.status !== 'pending') throw new DomainError('This draft was already decided.', 'conflict');
  const rev = reviewOf(r);
  if (rev.verdict === 'reject') {
    const why = rev.flags.filter((f) => f.severity === 'block').map((f) => f.message).join(' ');
    throw new DomainError(`The reviewer rejected this draft: ${why} Edit it so it passes, or reject it.`, 'invalid');
  }
  const [a] = await db
    .update(replyDrafts)
    .set({ status: 'approved', finalReply: r.draft, decidedBy: actorId, decidedAt: new Date() })
    .where(and(eq(replyDrafts.orgId, orgId), eq(replyDrafts.id, id), eq(replyDrafts.status, 'pending')))
    .returning();
  if (!a) throw new DomainError('This draft was already decided.', 'conflict');
  return a;
}

export async function rejectDraft(orgId: string, id: string, actorId: string, reason = ''): Promise<ReplyDraft> {
  await load(orgId, id);
  const [a] = await db
    .update(replyDrafts)
    .set({
      status: 'rejected',
      rejectReason: redactText(reason).trim().slice(0, 300) || null,
      decidedBy: actorId,
      decidedAt: new Date(),
    })
    .where(and(eq(replyDrafts.orgId, orgId), eq(replyDrafts.id, id), eq(replyDrafts.status, 'pending')))
    .returning();
  if (!a) throw new DomainError('This draft was already decided.', 'conflict');
  return a;
}

/**
 * A person rewrites the draft. The new text is redacted and goes through the
 * same code checks against the same cited passages; an edit that fails them
 * is refused and the draft stays as it was. Changes only this row.
 */
export async function editDraft(orgId: string, id: string, text: string): Promise<ReplyDraft> {
  const r = await load(orgId, id);
  if (r.status !== 'pending') throw new DomainError('Only pending drafts can be edited.', 'conflict');
  if (!r.covered) {
    throw new DomainError(
      'This question is not covered by the sources, so an edited answer would have nothing to cite. Approve the "not covered" reply or reject it.',
      'invalid',
    );
  }
  const clean = redactText(text).trim().slice(0, 1000);
  if (!clean) throw new DomainError('The reply cannot be empty.', 'invalid');
  if (sentenceCount(clean) > MAX_SENTENCES) {
    throw new DomainError(`Keep the reply to ${MAX_SENTENCES} sentences or fewer.`, 'invalid');
  }

  const { passages } = await loadCorpus(orgId);
  const byId = new Map(passages.map((p) => [p.id, p]));
  const cited = r.sources.map((s) => byId.get(s.passageId)).filter((p): p is Passage => Boolean(p));
  const checks = codeChecks({ reply: clean, covered: true, sources: r.sources, retrieved: cited }, r.question);
  const blocking = checks.filter((f) => f.severity === 'block');
  if (blocking.length) {
    throw new DomainError(`Edit not saved: ${blocking.map((f) => f.message).join(' ')}`, 'invalid');
  }

  const kept = reviewOf(r).flags.filter((f) => f.severity === 'info' && f.code !== 'edited');
  const flags: ReviewFlag[] = [
    ...checks,
    ...kept,
    { code: 'edited', severity: 'info', message: 'Edited by finance; re-checked in code against the same sources.' },
  ];
  const rev: Review = { verdict: verdictOf(flags), flags, model: 'skipped', checkedAt: new Date().toISOString() };

  const [u] = await db
    .update(replyDrafts)
    .set({ draft: clean, edited: true, review: { ...rev } })
    .where(and(eq(replyDrafts.orgId, orgId), eq(replyDrafts.id, id), eq(replyDrafts.status, 'pending')))
    .returning();
  if (!u) throw new DomainError('This draft was already decided.', 'conflict');
  return u;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the asker sees
// ─────────────────────────────────────────────────────────────────────────────

export interface MyQuestion {
  id: string;
  question: string;
  status: 'in_review' | 'answered' | 'declined';
  reply: string | null;
  sources: { title: string; url: string; lastChecked: string }[];
  askedAt: Date;
  decidedAt: Date | null;
}

function forAsker(r: ReplyDraft): MyQuestion {
  const status = r.status === 'approved' ? 'answered' : r.status === 'rejected' ? 'declined' : 'in_review';
  return {
    id: r.id,
    question: r.question,
    status,
    reply:
      status === 'answered'
        ? r.finalReply
        : status === 'declined'
          ? `Finance did not send an answer to this question${r.rejectReason ? `: ${r.rejectReason}` : '. Please ask your finance team.'}`
          : null,
    sources: status === 'answered' ? r.sources.map(({ title, url, lastChecked }) => ({ title, url, lastChecked })) : [],
    askedAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}

export async function myQuestions(user: Actor, limit = 10): Promise<MyQuestion[]> {
  const rows = await db
    .select()
    .from(replyDrafts)
    .where(and(eq(replyDrafts.orgId, user.orgId), eq(replyDrafts.userId, user.id)))
    .orderBy(desc(replyDrafts.createdAt))
    .limit(limit);
  return rows.map(forAsker);
}

export async function myQuestion(user: Actor, id: string): Promise<MyQuestion> {
  const r = await load(user.orgId, id);
  if (r.userId !== user.id) throw new DomainError('Question not found.', 'not_found');
  return forAsker(r);
}
