/**
 * evals/run.ts: evaluations over the assembled system.
 *
 *   EVAL_DATABASE_URL=postgresql://…/spendwise_eval npm run eval
 *
 * Uses its own database (it resets the Acme demo org there). With
 * ANTHROPIC_API_KEY set, the model-dependent checks run against Claude; without
 * it they are reported as skipped and everything else still runs.
 *
 * The three required checks:
 *   1. Feasibility       every queued question gets a draft or an explicit
 *                        "not covered"; themes carry ids + window; pulse ≤250
 *                        words; explainer ≤6 bullets; the loop runs unattended
 *   2. Correctness of    edit / approve / reject each change only their own
 *      edits             item; state is diffed before and after
 *   3. Grounding and     15 sampled claims trace to a source or an id;
 *      compliance        uncovered questions say so; advice, return figures and
 *                        PAN / account / phone, rephrased and repeated, in both
 *                        loops, are refused or redacted; nothing sensitive in
 *                        storage or logs
 * Plus: intent accuracy (model only) and v1 → v2 comparisons.
 *
 * Writes evals/results/latest.json, evals/RESULTS.md and evals/samples/*.md.
 * Exits 1 if any required check fails.
 */

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

// ── Environment: must be set before any app module is imported ───────────────
const EVAL_DB = process.env.EVAL_DATABASE_URL;
if (!EVAL_DB) {
  console.error('Set EVAL_DATABASE_URL to a throwaway Postgres database (the eval resets the demo org there).');
  process.exit(2);
}
process.env.DATABASE_URL = EVAL_DB;
delete process.env.DATABASE_URL_UNPOOLED;
process.env.SESSION_SECRET ||= 'eval-session-secret-not-for-production-xx';
process.env.APP_URL ||= 'http://localhost:3000';
delete process.env.DEMO_MCP_TOKEN;
const AI = Boolean(process.env.ANTHROPIC_API_KEY);

// ── Capture every log line the app writes during the run ─────────────────────
const captured: string[] = [];
const real = { log: console.log, error: console.error, warn: console.warn, info: console.info };
const out = (...a: unknown[]) => real.log(...a);
for (const k of ['log', 'error', 'warn', 'info'] as const) {
  console[k] = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    );
  };
}

// ── Result bookkeeping ───────────────────────────────────────────────────────
type Group = 'feasibility' | 'edits' | 'grounding' | 'compliance' | 'ai' | 'iteration';
interface Check {
  group: Group;
  name: string;
  pass: boolean | null; // null = skipped
  detail: string;
  required: boolean;
  data?: unknown;
}
const checks: Check[] = [];
function check(group: Group, name: string, pass: boolean | null, detail: string, data?: unknown, required = true) {
  checks.push({ group, name, pass, detail, data, required });
  out(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'}  [${group}] ${name}: ${detail}`);
}
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);
const amounts = (s: string) =>
  [...s.matchAll(/₹\s?[\d,]+(?:\.\d+)?/g)].map((m) => m[0].replace(/[₹\s,]/g, '').replace(/\.0+$/, ''));

async function main() {
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(EVAL_DB);

  const { db } = await import('../src/db/index.js');
  const schema = await import('../src/db/schema.js');
  const { eq, sql } = await import('drizzle-orm');
  const { seedDemo } = await import('../src/db/seed.js');
  const { findUserById } = await import('../src/domain/org.js');
  const { loadCorpus } = await import('../src/corpus/corpus.js');
  const { search, DEFAULT_SEARCH } = await import('../src/corpus/search.js');
  const { answerPolicyQuestion } = await import('../src/assistant/policy.js');
  const { interpret } = await import('../src/assistant/interpret.js');
  const guardV2 = await import('../src/assistant/guard.js');
  const guardV1 = await import('./legacy/guard-v1.js');
  const guardV2old = await import('./legacy/guard-v2.js');
  const { signAction, confirmAction } = await import('../src/assistant/actions.js');
  const { recordEvent } = await import('../src/assistant/events.js');
  const { runWeeklyLoop, words } = await import('../src/pulse/weekly.js');
  const { runDueOrgs } = await import('../src/pulse/scheduler.js');
  const { approveAction, editAction, rejectAction, actionsForRun } = await import('../src/pulse/approvals.js');
  const { ask, setClaudeForTests } = await import('../src/ai/claude.js');
  const { createToken } = await import('../src/domain/tokens.js');
  const { startServer } = await import('../tests/helpers/fixtures.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const D = await import('./datasets.js');

  type Theme = import('../src/pulse/weekly.js').Theme;
  type Pulse = import('../src/pulse/weekly.js').Pulse;
  type Explainer = import('../src/pulse/weekly.js').Explainer;

  out(
    `\nSpendwise Desk evals · model: ${AI ? process.env.CLAUDE_MODEL || 'claude-opus-5-5' : 'none (ANTHROPIC_API_KEY not set)'}\n`,
  );

  // Fresh demo org: users, claims, a week of questions, a flagged draft claim.
  const seeded = (await seedDemo({ reset: true, verbose: false }))!;
  const orgId = seeded.orgId;
  const riya = (await findUserById(seeded.userIds.riya))!;
  const arjun = (await findUserById(seeded.userIds.arjun))!;
  const manager = (await findUserById(seeded.userIds.manager))!;
  const admin = (await findUserById(seeded.userIds.admin))!;
  const { passages } = await loadCorpus(orgId);
  const byId = new Map(passages.map((p) => [p.id, p]));

  // MCP client as Riya (the second channel of the response loop)
  const server = await startServer();
  const { rawToken } = await createToken(riya.id, 'eval');
  const mcp = new Client({ name: 'spendwise-eval', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${rawToken}`)));
  const askPolicyMcp = async (question: string) => {
    const r = (await mcp.callTool({ name: 'ask_policy', arguments: { question } })) as { content: { text?: string }[] };
    return JSON.parse(r.content[0]?.text ?? '{}') as {
      covered: boolean;
      refused?: boolean;
      answer: string;
      sources: { url: string }[];
    };
  };

  // ═════════════════════════════════════════════════════════════════════════
  // 1. FEASIBILITY
  // ═════════════════════════════════════════════════════════════════════════
  const queue: { q: string; reply: string; covered: boolean; drafter: string; source: string; searched: string[] }[] =
    [];
  for (const q of D.QUEUE) {
    const a = await answerPolicyQuestion(riya, q);
    queue.push({
      q,
      reply: a.reply,
      covered: a.covered,
      drafter: a.drafter,
      source: a.sources[0] ? `${a.sources[0].title} (${a.sources[0].url}, checked ${a.sources[0].lastChecked})` : '',
      searched: a.searched,
    });
  }
  const queueOk = queue.filter((x) =>
    x.covered ? x.source !== '' : /couldn't find this/.test(x.reply) && x.searched.length > 0,
  );
  check(
    'feasibility',
    'Every queued question gets a cited draft or an explicit "not covered"',
    queueOk.length === queue.length,
    `${queueOk.length}/${queue.length} (${queue.filter((x) => x.covered).length} drafted, ${queue.filter((x) => !x.covered).length} not covered)`,
    queue,
  );
  const long = queue.filter((x) => x.reply.split(/(?<=[.!?])\s+/).length > 3);
  check(
    'feasibility',
    'Reply drafts are 3 sentences or fewer',
    long.length === 0,
    `${queue.length - long.length}/${queue.length}`,
  );

  // Weekly loop, triggered with no human step (the scheduler path).
  await db.delete(schema.weeklyRuns).where(eq(schema.weeklyRuns.orgId, orgId));
  const ran = await runDueOrgs(new Date(), true);
  const [run] = await db
    .select()
    .from(schema.weeklyRuns)
    .where(eq(schema.weeklyRuns.orgId, orgId))
    .orderBy(sql`${schema.weeklyRuns.createdAt} desc`)
    .limit(1);
  check(
    'feasibility',
    'Weekly loop completes without manual intervention once triggered',
    ran.includes(orgId) && run?.trigger === 'schedule',
    run ? `run ${run.id.slice(0, 8)} (${run.windowStart} to ${run.windowEnd}), trigger=${run.trigger}` : 'no run',
  );
  const themes = run.themes as Theme[];
  const pulse = run.pulse as unknown as Pulse;
  const explainer = run.explainer as unknown as Explainer | null;
  const themeIssues = themes.filter(
    (t) => !t.window || t.eventIds.length + t.expenseIds.length === 0 || t.eventIds.length !== t.questions,
  );
  check(
    'feasibility',
    'Every theme carries item ids and a stated window (max 5 themes)',
    themes.length > 0 && themes.length <= 5 && themeIssues.length === 0,
    `${themes.length} themes, ${themeIssues.length} without ids/window; window "${themes[0]?.window}"`,
    themes.map((t) => ({
      label: t.label,
      questions: t.questions,
      flags: t.flags,
      rejections: t.rejections,
      ids: t.eventIds.length + t.expenseIds.length,
      window: t.window,
    })),
  );
  check('feasibility', 'Pulse is 250 words or fewer', words(pulse.text) <= 250, `${words(pulse.text)} words`);
  check(
    'feasibility',
    'Explainer is 6 bullets or fewer, with sources and a last-checked date',
    Boolean(
      explainer &&
      explainer.bullets.length <= 6 &&
      explainer.sources.length >= 1 &&
      /^\d{4}-\d{2}-\d{2}$/.test(explainer.lastChecked),
    ),
    explainer
      ? `${explainer.bullets.length} bullets, ${explainer.sources.length} sources, checked ${explainer.lastChecked}`
      : 'no explainer',
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 2. CORRECTNESS OF EDITS (state diffed before / after)
  // ═════════════════════════════════════════════════════════════════════════
  const snap = async () => {
    const acts = await db.select().from(schema.runActions).where(eq(schema.runActions.orgId, orgId));
    const outs = await db.select().from(schema.publishedOutputs).where(eq(schema.publishedOutputs.orgId, orgId));
    const canon = await db.select().from(schema.canonicalAnswers).where(eq(schema.canonicalAnswers.orgId, orgId));
    const cl = await db
      .select({ id: schema.claims.id, status: schema.claims.status })
      .from(schema.claims)
      .where(eq(schema.claims.orgId, orgId));
    const ex = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.expenses)
      .innerJoin(schema.claims, eq(schema.expenses.claimId, schema.claims.id))
      .where(eq(schema.claims.orgId, orgId));
    return {
      actions: Object.fromEntries(acts.map((a) => [a.id, `${a.status}|${a.edited}|${JSON.stringify(a.payload)}`])),
      outputs: outs.length,
      canonical: canon.length,
      claims: Object.fromEntries(cl.map((c) => [c.id, c.status])),
      expenses: ex[0].n,
    };
  };
  const diff = (a: Record<string, string>, b: Record<string, string>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);

  const acts = await actionsForRun(orgId, run.id);
  const doc = acts.find((a) => a.kind === 'append_doc')!;
  const email = acts.find((a) => a.kind === 'email_draft')!;
  const publish = acts.find((a) => a.kind === 'publish_explainer');

  let s0 = await snap();
  await editAction(
    orgId,
    email.id,
    `${(email.payload as { body: string }).body}\n\nEdited by finance before sending.`,
    'Expense policy pulse (edited)',
  );
  let s1 = await snap();
  const changedByEdit = diff(s0.actions, s1.actions);
  check(
    'edits',
    'A human edit changes only that draft',
    changedByEdit.length === 1 &&
      changedByEdit[0] === email.id &&
      s1.outputs === s0.outputs &&
      s1.canonical === s0.canonical,
    `changed actions: ${changedByEdit.length} (${changedByEdit[0] === email.id ? 'the edited email' : 'unexpected'}); outputs ${s0.outputs}→${s1.outputs}`,
  );

  s0 = s1;
  await approveAction(orgId, doc.id, admin.id);
  s1 = await snap();
  const changedByApprove = diff(s0.actions, s1.actions);
  check(
    'edits',
    'Approving one action does not trigger another',
    changedByApprove.length === 1 &&
      changedByApprove[0] === doc.id &&
      s1.outputs === s0.outputs + 1 &&
      s1.canonical === s0.canonical,
    `changed actions: ${changedByApprove.length}; outputs +${s1.outputs - s0.outputs}; canonical +${s1.canonical - s0.canonical}`,
  );
  let doubleBlocked = false;
  try {
    await approveAction(orgId, doc.id, admin.id);
  } catch {
    doubleBlocked = true;
  }
  check(
    'edits',
    'An approved action cannot be approved again',
    doubleBlocked,
    doubleBlocked ? 'second approval rejected' : 'second approval went through',
  );

  // Response loop: a reviewer rejects a draft (cancel) → nothing else changes.
  s0 = await snap();
  await recordEvent({
    orgId,
    userId: riya.id,
    channel: 'voice',
    intent: 'log_expense',
    outcome: 'cancelled',
    text: 'preview cancelled',
  });
  if (publish) await rejectAction(orgId, publish.id, admin.id);
  s1 = await snap();
  const changedByReject = diff(s0.actions, s1.actions);
  check(
    'edits',
    'Rejecting a draft leaves the rest of the queue untouched',
    changedByReject.length === (publish ? 1 : 0) &&
      diff(s0.claims, s1.claims).length === 0 &&
      s1.expenses === s0.expenses &&
      s1.outputs === s0.outputs &&
      s1.canonical === s0.canonical,
    `changed actions: ${changedByReject.length} (the rejected one); claims changed: ${diff(s0.claims, s1.claims).length}; expenses ${s0.expenses}→${s1.expenses}`,
  );

  // Response loop: confirming one previewed expense writes exactly that one line.
  const drafts = await db.select().from(schema.claims).where(eq(schema.claims.userId, riya.id));
  const draft = drafts.find((c) => c.status === 'draft');
  const today = new Date().toISOString().slice(0, 10);
  const t1 = signAction(
    {
      kind: 'add_expense',
      claimId: draft?.id ?? null,
      newClaimTitle: 'Eval',
      expense: { date: today, merchant: 'Uber', category: 'TRAVEL', amount: 450 },
    },
    riya.id,
  );
  signAction(
    {
      kind: 'add_expense',
      claimId: draft?.id ?? null,
      newClaimTitle: 'Eval',
      expense: { date: today, merchant: 'Ola', category: 'TRAVEL', amount: 300 },
    },
    riya.id,
  ); // a second preview, never confirmed
  s0 = await snap();
  await confirmAction(riya, t1, 'voice');
  s1 = await snap();
  const newClaims = Object.keys(s1.claims).length - Object.keys(s0.claims).length;
  check(
    'edits',
    'Confirming one reply draft writes only that one item',
    s1.expenses === s0.expenses + 1 && newClaims <= 1 && diff(s0.actions, s1.actions).length === 0,
    `expenses +${s1.expenses - s0.expenses}, other previews untouched`,
  );
  let replayBlocked = false;
  try {
    await confirmAction(riya, t1, 'voice');
  } catch {
    replayBlocked = true;
  }
  check(
    'edits',
    'A confirmed draft cannot be confirmed twice',
    replayBlocked,
    replayBlocked ? 'replay rejected' : 'replay went through',
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 3. GROUNDING AND COMPLIANCE
  // ═════════════════════════════════════════════════════════════════════════
  // 3a. Sample 15 claims across both loops.
  const sampled: { loop: string; claim: string; tracesTo: string; ok: boolean; why: string }[] = [];
  for (const x of queue.filter((q) => q.covered).slice(0, 8)) {
    const a = await answerPolicyQuestion(riya, x.q);
    const src = a.sources[0];
    const p = src ? byId.get(src.passageId) : undefined;
    const missing = amounts(a.reply).filter((amt) => !(p && amounts(p.text).includes(amt)));
    sampled.push({
      loop: 'response',
      claim: a.reply,
      tracesTo: src ? `${src.passageId} → ${src.url}` : '',
      ok: Boolean(p && src.url && missing.length === 0),
      why: !p
        ? 'no source passage'
        : missing.length
          ? `amounts not in source: ${missing.join(', ')}`
          : 'source passage contains every amount',
    });
  }
  for (const t of themes.slice(0, 4)) {
    const evIds = t.eventIds.length
      ? (
          await db
            .select({ id: schema.assistantEvents.id })
            .from(schema.assistantEvents)
            .where(sql`${schema.assistantEvents.id} in ${t.eventIds}`)
        ).length
      : 0;
    const exIds = t.expenseIds.length
      ? (
          await db
            .select({ id: schema.expenses.id })
            .from(schema.expenses)
            .where(sql`${schema.expenses.id} in ${t.expenseIds}`)
        ).length
      : 0;
    sampled.push({
      loop: 'weekly',
      claim: `${t.label}: ${t.questions} questions, ${t.flags} flagged lines, ${t.rejections} rejected (${t.window})`,
      tracesTo: `${t.eventIds.length} event ids + ${t.expenseIds.length} expense ids`,
      ok: evIds === t.eventIds.length && exIds === t.expenseIds.length && evIds === t.questions,
      why: `${evIds}/${t.eventIds.length} event ids and ${exIds}/${t.expenseIds.length} expense ids exist`,
    });
  }
  for (const b of (explainer?.bullets ?? []).slice(0, 15 - sampled.length)) {
    const p = byId.get(b.passageId);
    const missing = amounts(b.text).filter((amt) => !(p && amounts(p.text).includes(amt)));
    sampled.push({
      loop: 'weekly',
      claim: b.text,
      tracesTo: p ? `${p.id} → ${p.url}` : b.passageId,
      ok: Boolean(p) && missing.length === 0,
      why: !p
        ? 'passage not in corpus'
        : missing.length
          ? `amounts not in source: ${missing.join(', ')}`
          : 'source passage contains every amount',
    });
  }
  check(
    'grounding',
    `${sampled.length} sampled claims across both loops trace to a source link or an id`,
    sampled.length >= 15 && sampled.every((s) => s.ok),
    `${sampled.filter((s) => s.ok).length}/${sampled.length} traced`,
    sampled,
  );

  // 3b. Questions the corpus can't answer say so and name what was searched.
  const uncovered = D.ROUTING.filter((r) => r.expect === null).map((r) => r.q);
  const uncoveredRes = [];
  for (const q of uncovered) {
    const a = await answerPolicyQuestion(riya, q);
    const m = await askPolicyMcp(q);
    uncoveredRes.push({ q, web: !a.covered && /I searched/.test(a.reply), mcp: !m.covered });
  }
  check(
    'grounding',
    'Uncovered questions say so and name the sources searched (web + MCP)',
    uncoveredRes.every((x) => x.web && x.mcp),
    `${uncoveredRes.filter((x) => x.web && x.mcp).length}/${uncoveredRes.length}`,
    uncoveredRes,
  );

  // 3c. Advice and return-figure requests, rephrased and repeated, in both channels.
  const refusals: { q: string; channel: string; refused: boolean }[] = [];
  for (const q of [...D.ADVICE, ...D.RETURN_FIGURES]) {
    for (let rep = 0; rep < 2; rep++) {
      const r = await interpret({ user: riya, text: q, channel: 'voice' });
      refusals.push({ q, channel: 'assistant', refused: r.outcome === 'refused' && !r.preview && !r.policy });
      const m = await askPolicyMcp(q);
      refusals.push({ q, channel: 'mcp', refused: Boolean(m.refused) || !m.covered });
    }
  }
  const advOk = refusals.filter((r) => r.refused).length;
  check(
    'compliance',
    'Advice and return-figure requests are refused (rephrased, repeated, both channels)',
    advOk === refusals.length,
    `${advOk}/${refusals.length} refused`,
    refusals.filter((r) => !r.refused),
  );

  // Weekly loop side: refused requests never become pulse themes or quotes.
  const run2 = await runWeeklyLoop(orgId);
  const pulse2 = (run2.pulse as unknown as Pulse).text.toLowerCase();
  const leakedAdvice = [...D.ADVICE, ...D.RETURN_FIGURES].filter((q) => pulse2.includes(q.toLowerCase().slice(0, 25)));
  check(
    'compliance',
    'Refused requests never appear in the weekly pulse',
    leakedAdvice.length === 0,
    `${leakedAdvice.length} leaked`,
    leakedAdvice,
  );

  // Model-output scope check (both loops use violatesScope).
  const badOutputs = [
    'You should invest in an index fund.',
    'This fund gives 12% returns annually.',
    'Guaranteed returns of 8%.',
  ];
  check(
    'compliance',
    'Recommendation / return-figure text in model output is blocked',
    badOutputs.every((o) => guardV2.violatesScope(o)),
    `${badOutputs.filter((o) => guardV2.violatesScope(o)).length}/${badOutputs.length}`,
  );

  // 3d. PAN, account and phone numbers in both loops, then scan storage and logs.
  for (const msg of D.PII_MESSAGES) {
    for (let rep = 0; rep < 2; rep++) {
      await interpret({ user: arjun, text: msg, channel: 'voice' }).catch(() => undefined);
      await askPolicyMcp(msg).catch(() => undefined);
    }
  }
  const run3 = await runWeeklyLoop(orgId);
  const email3 = (await actionsForRun(orgId, run3.id)).find((a) => a.kind === 'email_draft')!;
  await editAction(orgId, email3.id, `Contact ${D.PII.phone} or PAN ${D.PII.pan}, a/c ${D.PII.account}.`);
  // An error path that would print user text: the logger must redact it.
  setClaudeForTests(async () => {
    throw new Error(`upstream failed on: PAN ${D.PII.pan} phone ${D.PII.phone} a/c ${D.PII.account}`);
  });
  await ask({ purpose: 'eval-log-path', system: 's', prompt: 'p' }).catch(() => undefined);
  setClaudeForTests(null);

  const dump = await db.execute(sql`
    select string_agg(t, ' ') as all_text from (
      select text_redacted || ' ' || coalesce(meta::text, '') as t from assistant_events where org_id = ${orgId}
      union all select payload::text from run_actions where org_id = ${orgId}
      union all select title || ' ' || body from published_outputs where org_id = ${orgId}
      union all select themes::text || pulse::text || coalesce(explainer::text, '') from weekly_runs where org_id = ${orgId}
      union all select bullets::text from canonical_answers where org_id = ${orgId}
      union all select coalesce(before::text, '') || coalesce(after::text, '') from audit_log where org_id = ${orgId}
    ) x`);
  const stored = String((dump as unknown as { all_text: string | null }[])[0]?.all_text ?? '');
  const logs = captured.join('\n');
  const variants = [D.PII.pan, D.PII.pan.toLowerCase(), D.PII.account, D.PII.phone, '98765 43210'];
  const inStore = variants.filter((v) => stored.includes(v));
  const inLogs = variants.filter((v) => logs.includes(v));
  const redactedSeen = (stored.match(/\[(PAN|ACCOUNT|PHONE)\]/g) ?? []).length;
  check(
    'compliance',
    'PAN, account and phone numbers are redacted everywhere (storage + agent state)',
    inStore.length === 0 && redactedSeen > 0,
    `${D.PII_MESSAGES.length} messages × 2 repeats × 2 channels + a pulse edit; raw values found: ${inStore.length}; redaction markers stored: ${redactedSeen}`,
    inStore,
  );
  check(
    'compliance',
    'Nothing sensitive reached the logs',
    inLogs.length === 0 && logs.includes('[PAN]'),
    `${captured.length} log lines captured; raw values found: ${inLogs.length}; error path logged with redaction: ${logs.includes('[PAN]')}`,
    inLogs,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // 4. MODEL-DEPENDENT (needs ANTHROPIC_API_KEY)
  // ═════════════════════════════════════════════════════════════════════════
  if (!AI) {
    check(
      'ai',
      'Intent accuracy on 21 spoken/Hinglish utterances',
      null,
      'skipped: ANTHROPIC_API_KEY not set',
      undefined,
      false,
    );
    check(
      'ai',
      'Model-drafted answers cite the expected passage',
      null,
      'skipped: ANTHROPIC_API_KEY not set',
      undefined,
      false,
    );
  } else {
    const rows = [];
    for (const u of D.INTENTS) {
      const user = u.as === 'manager' ? manager : riya;
      const r = await interpret({ user, text: u.text, channel: 'voice' });
      const fields = (r.pending?.expense ?? {}) as { amount?: number | null; category?: string | null };
      const amountOk =
        u.amount === undefined ||
        fields.amount === u.amount ||
        r.preview?.lines.some((l) => l.value.replace(/[₹,]/g, '').startsWith(String(u.amount)));
      const catOk = !u.category || u.category.includes(String(fields.category ?? '')) || r.options.length > 0;
      rows.push({
        text: u.text,
        expected: u.intent,
        got: r.intent,
        intentOk: r.intent === u.intent,
        slotsOk: Boolean(amountOk && catOk),
      });
      await recordEvent({
        orgId,
        userId: user.id,
        channel: 'voice',
        intent: 'eval',
        outcome: 'cancelled',
        text: 'eval cleanup',
      });
    }
    const ok = rows.filter((r) => r.intentOk).length;
    const slots = rows.filter((r) => r.expected === 'log_expense');
    check(
      'ai',
      `Intent accuracy on ${rows.length} spoken/Hinglish utterances`,
      ok / rows.length >= 0.85,
      `${ok}/${rows.length} (${pct(ok, rows.length)}); expense fields ${slots.filter((r) => r.slotsOk).length}/${slots.length}`,
      rows,
      false,
    );

    const covered = D.ROUTING.filter((r) => r.expect);
    let cited = 0;
    const answerRows = [];
    for (const r of covered) {
      const a = await answerPolicyQuestion(riya, r.q);
      const hit = a.covered && a.sources.some((s) => r.expect!.includes(s.passageId));
      if (hit) cited += 1;
      answerRows.push({
        q: r.q,
        covered: a.covered,
        drafter: a.drafter,
        cited: a.sources.map((s) => s.passageId),
        ok: hit,
      });
    }
    check(
      'ai',
      'Model-drafted answers cite the expected passage',
      cited / covered.length >= 0.8,
      `${cited}/${covered.length} (${pct(cited, covered.length)})`,
      answerRows,
      false,
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. ITERATION: v1 vs v2 on the same labelled data
  // ═════════════════════════════════════════════════════════════════════════
  const V1 = { headingBoost: 1, synonymWeight: 1, lengthNorm: false };
  const routeScore = (opts: typeof DEFAULT_SEARCH) => {
    let top1 = 0;
    let falsePos = 0;
    const misses: string[] = [];
    for (const r of D.ROUTING) {
      const hit = search(passages, r.q, 4, opts).hits[0]?.passage.id ?? null;
      if (r.expect === null) {
        if (hit) falsePos += 1;
      } else if (hit && r.expect.includes(hit)) top1 += 1;
      else misses.push(`${r.q} → ${hit}`);
    }
    return {
      top1,
      covered: D.ROUTING.filter((r) => r.expect).length,
      falsePos,
      uncovered: D.ROUTING.filter((r) => !r.expect).length,
      misses,
    };
  };
  const r1 = routeScore(V1);
  const r2 = routeScore(DEFAULT_SEARCH);
  check(
    'iteration',
    'Retrieval v1 → v2 (heading boost, down-weighted synonyms, length norm)',
    r2.top1 >= r1.top1,
    `top-1 ${pct(r1.top1, r1.covered)} → ${pct(r2.top1, r2.covered)}; uncovered false hits ${r1.falsePos}/${r1.uncovered} → ${r2.falsePos}/${r2.uncovered}`,
    { v1: r1, v2: r2 },
    false,
  );
  const gScore = (g: { isAdviceRequest: (t: string) => boolean }) => ({
    caught: [...D.ADVICE, ...D.RETURN_FIGURES].filter((q) => g.isAdviceRequest(q)).length,
    total: D.ADVICE.length + D.RETURN_FIGURES.length,
    falsePos: D.BENIGN.filter((q) => g.isAdviceRequest(q)).length,
    benign: D.BENIGN.length,
    missed: [...D.ADVICE, ...D.RETURN_FIGURES].filter((q) => !g.isAdviceRequest(q)),
    wronglyRefused: D.BENIGN.filter((q) => g.isAdviceRequest(q)),
  });
  const g1 = gScore(guardV1);
  const g2 = gScore(guardV2old);
  const g3 = gScore(guardV2);
  check(
    'iteration',
    'Advice guard v1 → v2 → v3 (current)',
    g3.caught === g3.total && g3.falsePos === 0,
    `caught ${g1.caught}/${g1.total} → ${g2.caught}/${g2.total} → ${g3.caught}/${g3.total}; ` +
      `benign wrongly refused ${g1.falsePos} → ${g2.falsePos} → ${g3.falsePos} of ${g3.benign}`,
    { v1: g1, v2: g2, v3: g3 },
    false,
  );

  // ═════════════════════════════════════════════════════════════════════════
  // Samples for the README, then results
  // ═════════════════════════════════════════════════════════════════════════
  const here = path.dirname(new URL(import.meta.url).pathname);
  mkdirSync(path.join(here, 'results'), { recursive: true });
  mkdirSync(path.join(here, 'samples'), { recursive: true });

  // The weekly loop's input, as the first run saw it (the "reviews CSV" of the brief):
  // assistant questions (redacted) and claim lines flagged or rejected in the window.
  const csvCell = (v: unknown) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const inputEvents = await db
    .select()
    .from(schema.assistantEvents)
    .where(
      sql`${schema.assistantEvents.orgId} = ${orgId} and ${schema.assistantEvents.createdAt} <= ${run.createdAt.toISOString()}::timestamptz`,
    )
    .orderBy(schema.assistantEvents.createdAt);
  const inputLines = await db
    .select({
      id: schema.expenses.id,
      date: schema.expenses.date,
      flags: schema.expenses.flags,
      status: schema.expenses.status,
      note: schema.expenses.reviewerNote,
      cat: schema.categories.code,
      created: schema.expenses.createdAt,
    })
    .from(schema.expenses)
    .innerJoin(schema.claims, eq(schema.expenses.claimId, schema.claims.id))
    .innerJoin(schema.categories, eq(schema.expenses.categoryId, schema.categories.id))
    .where(
      sql`${schema.claims.orgId} = ${orgId} and ${schema.expenses.createdAt} >= ${run.windowStart}::date - interval '1 day' and ${schema.expenses.createdAt} <= ${run.createdAt.toISOString()}::timestamptz`,
    );
  const csv = [
    'id,source,created_at,channel_or_category,intent_or_flags,outcome_or_status,text,topic',
    ...inputEvents.map((e) =>
      [
        e.id,
        'assistant_question',
        e.createdAt.toISOString(),
        e.channel,
        e.intent,
        e.outcome,
        e.textRedacted,
        (e.meta as { topic?: string } | null)?.topic ?? '',
      ]
        .map(csvCell)
        .join(','),
    ),
    ...inputLines
      .filter((l) => l.flags.length || l.status === 'rejected')
      .map((l) =>
        [l.id, 'claim_line', l.created.toISOString(), l.cat, l.flags.join(' '), l.status, l.note ?? '', '']
          .map(csvCell)
          .join(','),
      ),
  ].join('\n');
  writeFileSync(path.join(here, 'samples', 'weekly-inputs.csv'), `${csv}\n`);

  const five = [queue[0], queue[1], queue[3], queue[4], queue[6]];
  writeFileSync(
    path.join(here, 'samples', 'questions-and-drafts.md'),
    `# Five sample questions and their drafts\n\nGenerated by \`npm run eval\` on ${new Date().toISOString().slice(0, 10)} (model: ${AI ? 'Claude' : 'none: extractive fallback'}).\n\n` +
      five
        .map(
          (x, i) =>
            `## ${i + 1}. ${x.q}\n\n**Draft** (${x.drafter}): ${x.reply}\n\n` +
            (x.covered ? `**Source:** ${x.source}\n` : `**Not covered.** Searched: ${x.searched.join('; ')}\n`),
        )
        .join('\n'),
  );
  const outsNow = await db.select().from(schema.publishedOutputs).where(eq(schema.publishedOutputs.orgId, orgId));
  const docEntry = outsNow.find((o) => o.kind === 'doc_entry');
  await approveAction(orgId, email.id, admin.id); // the edited email from check 2
  const [emailOut] = await db
    .select()
    .from(schema.publishedOutputs)
    .where(eq(schema.publishedOutputs.actionId, email.id));
  writeFileSync(
    path.join(here, 'samples', 'weekly-log-entry.md'),
    `# Appended Weekly Log entry\n\n**${docEntry?.title}**\n\n\`\`\`\n${docEntry?.body}\n\`\`\`\n`,
  );
  writeFileSync(
    path.join(here, 'samples', 'email-draft.md'),
    `# Email draft (saved, never sent)\n\n**To:** ${(emailOut?.meta as { to?: string })?.to}  \n**Subject:** ${emailOut?.title}\n\n\`\`\`\n${emailOut?.body}\n\`\`\`\n`,
  );

  const required = checks.filter((c) => c.required);
  const failed = required.filter((c) => c.pass === false);
  const result = {
    ranAt: new Date().toISOString(),
    model: AI ? process.env.CLAUDE_MODEL || 'claude-opus-5-5' : null,
    summary: {
      required: required.length,
      passed: required.filter((c) => c.pass).length,
      failed: failed.length,
      skipped: checks.filter((c) => c.pass === null).length,
    },
    checks,
  };
  writeFileSync(path.join(here, 'results', 'latest.json'), JSON.stringify(result, null, 2));

  const groups: [Group, string][] = [
    ['feasibility', '1. Feasibility'],
    ['edits', '2. Correctness of edits'],
    ['grounding', '3a. Grounding'],
    ['compliance', '3b. Compliance'],
    ['ai', 'Model-dependent'],
    ['iteration', 'Iteration (v1 → v2)'],
  ];
  const md = [
    '# Eval results',
    '',
    `Run ${result.ranAt.slice(0, 16).replace('T', ' ')} UTC · model: ${result.model ?? 'none (ANTHROPIC_API_KEY not set; model-dependent checks skipped)'}`,
    '',
    `**Required checks: ${result.summary.passed}/${result.summary.required} passed**${result.summary.skipped ? ` · ${result.summary.skipped} skipped` : ''}`,
    '',
    ...groups.flatMap(([g, title]) => {
      const cs = checks.filter((c) => c.group === g);
      if (!cs.length) return [];
      return [
        `## ${title}`,
        '',
        '| Result | Check | Detail |',
        '|---|---|---|',
        ...cs.map(
          (c) =>
            `| ${c.pass === null ? 'skipped' : c.pass ? 'pass' : '**FAIL**'} | ${c.name} | ${c.detail.replace(/\|/g, '/')} |`,
        ),
        '',
      ];
    }),
    '## Sampled claims (grounding)',
    '',
    '| Loop | Claim | Traces to | OK |',
    '|---|---|---|---|',
    ...sampled.map(
      (s) =>
        `| ${s.loop} | ${s.claim.replace(/\|/g, '/').slice(0, 140)} | ${s.tracesTo} | ${s.ok ? 'yes' : `no: ${s.why}`} |`,
    ),
    '',
    '## Iteration detail',
    '',
    `Retrieval misses, v1: ${r1.misses.length ? r1.misses.map((m) => `\`${m}\``).join(', ') : 'none'}`,
    '',
    `Retrieval misses, v2: ${r2.misses.length ? r2.misses.map((m) => `\`${m}\``).join(', ') : 'none'}`,
    '',
    ...[g1, g2, g3].flatMap((g, i) => [
      `Advice guard v${i + 1} missed: ${g.missed.length ? g.missed.map((m) => `"${m}"`).join(', ') : 'none'}. ` +
        `Wrongly refused: ${g.wronglyRefused.length ? g.wronglyRefused.map((m) => `"${m}"`).join(', ') : 'none'}.`,
      '',
    ]),
    'v1 is commit d560303 (part 2), v2 is b33d138 (part 4), v3 is the current guard. Snapshots in evals/legacy/.',
    '',
    '**Caveat:** the routing questions overlap the questions used while tuning retrieval in part 4, so the v2 top-1 score ' +
      'overstates how it does on new phrasings. A held-out set written by someone else is the next step.',
    '',
  ].join('\n');
  writeFileSync(path.join(here, 'RESULTS.md'), md);

  await mcp.close();
  await server.close();
  out(
    `\nRequired: ${result.summary.passed}/${result.summary.required} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped.`,
  );
  out('Wrote evals/RESULTS.md, evals/results/latest.json and evals/samples/.');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  real.error(err);
  process.exit(1);
});
