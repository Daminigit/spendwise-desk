/**
 * src/pulse/weekly.ts
 *
 * The weekly loop. Three data sources answer one question ("what is
 * confusing people about our expense policy, and what is the right answer?"):
 *
 *   1. Questions people asked the assistant  (assistant_events, redacted)
 *   2. What actually happened on claims      (policy flags, rejected lines)
 *   3. What the sources say                  (company policy + CBIC corpus)
 *
 * Questions and flags are grouped by the corpus passage they relate to, so a
 * theme like "Supplier GSTIN" counts both the people asking about GSTIN and
 * the lines flagged for a missing GSTIN. Grouping, counts, ids, quotes and
 * the window are all computed in code. Claude only writes a short summary,
 * three action ideas and the explainer bullets, and code checks those.
 *
 * Nothing is written anywhere: the run produces drafts plus three actions
 * that wait on the approval screen (see approvals.ts).
 */

import { randomUUID } from 'crypto';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { assistantEvents, categories, claims, expenses, runActions, weeklyRuns, type WeeklyRun } from '../db/schema.js';
import { askJson, AiUnavailableError } from '../ai/model.js';
import { redactText } from '../ai/redact.js';
import { loadCorpus, todayIso, type Passage } from '../corpus/corpus.js';
import { search } from '../corpus/search.js';
import { ungroundedNumbers } from '../corpus/grounding.js';
import { getOrganisation } from '../domain/org.js';
import { FLAG_LABELS } from '../web/util.js';
import { violatesScope } from '../assistant/guard.js';
import { findCanonical } from './canonical.js';

// ─────────────────────────────────────────────────────────────────────────────
// Limits from the brief
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_THEMES = 5;
export const TOP_THEMES = 3;
export const REPEAT_THRESHOLD = 5; // same question this many times in a week → must appear in the pulse
export const PULSE_WORD_CAP = 250;
export const EXPLAINER_BULLET_CAP = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface Theme {
  key: string;
  label: string;
  passageId: string | null;
  window: string; // human-readable, e.g. "18–24 Nov 2026"
  questions: number;
  flags: number;
  rejections: number;
  total: number;
  repeated: boolean;
  /** Traceability: every item behind the counts. */
  eventIds: string[];
  expenseIds: string[];
  quotes: { id: string; text: string }[];
}

export interface Pulse {
  text: string;
  wordCount: number;
  summary: string;
  actions: string[];
  aiWritten: boolean;
}

export interface Explainer {
  topic: string;
  title: string;
  bullets: { text: string; passageId: string }[];
  sources: { title: string; url: string; lastChecked: string }[];
  lastChecked: string;
  aiWritten: boolean;
  alreadyCanonical: boolean;
}

export interface Window {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
}

// ─────────────────────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────────────────────

export function lastSevenDays(endIso = todayIso()): Window {
  const end = new Date(`${endIso}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { start: start.toISOString().slice(0, 10), end: endIso };
}

/** IST day boundaries as instants. */
function bounds(w: Window): { from: Date; to: Date } {
  const to = new Date(`${w.end}T00:00:00+05:30`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from: new Date(`${w.start}T00:00:00+05:30`), to };
}

export function windowLabel(w: Window): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
  const sameMonth = w.start.slice(0, 7) === w.end.slice(0, 7);
  return sameMonth
    ? `${fmt(w.start, { day: 'numeric' })}–${fmt(w.end, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : `${fmt(w.start, { day: 'numeric', month: 'short' })} – ${fmt(w.end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Gather + group (code only)
// ─────────────────────────────────────────────────────────────────────────────

/** Which corpus passage a policy flag is about. */
export function flagTopic(flag: string, categoryCode: string): string {
  switch (flag) {
    case 'MISSING_GSTIN':
    case 'INVALID_GSTIN':
    case 'GST_MISMATCH':
      return 'policy-gstin';
    case 'OVER_ITEM_LIMIT':
    case 'OVER_DAY_LIMIT':
      return `policy-limit-${categoryCode.toLowerCase()}`;
    case 'WEEKEND':
      return 'policy-weekend';
    case 'MISSING_RECEIPT':
      return 'policy-receipts';
    default:
      return `flag-${flag.toLowerCase()}`;
  }
}

export interface Gathered {
  themes: Theme[];
  stats: {
    window: string;
    questions: number;
    notCovered: number;
    canonicalReused: number;
    adviceRefused: number;
    expensesLogged: number;
    flaggedLines: number;
    rejectedLines: number;
  };
}

export async function gather(orgId: string, w: Window, passages: Passage[]): Promise<Gathered> {
  const { from, to } = bounds(w);
  const label = windowLabel(w);
  const byPassage = new Map(passages.map((p) => [p.id, p]));

  const events = await db
    .select()
    .from(assistantEvents)
    .where(
      and(eq(assistantEvents.orgId, orgId), gte(assistantEvents.createdAt, from), lt(assistantEvents.createdAt, to)),
    );

  const lines = await db
    .select({
      id: expenses.id,
      flags: expenses.flags,
      status: expenses.status,
      reviewerNote: expenses.reviewerNote,
      createdAt: expenses.createdAt,
      updatedAt: expenses.updatedAt,
      categoryCode: categories.code,
    })
    .from(expenses)
    .innerJoin(claims, eq(expenses.claimId, claims.id))
    .innerJoin(categories, eq(expenses.categoryId, categories.id))
    .where(
      and(
        eq(claims.orgId, orgId),
        sql`((${expenses.createdAt} >= ${from.toISOString()}::timestamptz and ${expenses.createdAt} < ${to.toISOString()}::timestamptz)
          or (${expenses.status} = 'rejected' and ${expenses.updatedAt} >= ${from.toISOString()}::timestamptz and ${expenses.updatedAt} < ${to.toISOString()}::timestamptz))`,
      ),
    );

  const themes = new Map<string, Theme>();
  const theme = (key: string): Theme => {
    let t = themes.get(key);
    if (!t) {
      const p = byPassage.get(key);
      t = {
        key,
        label: p
          ? p.heading
          : key.startsWith('uncovered:')
            ? `Not covered by sources (${key.slice(10).split('+').join(', ')})`
            : key === 'rejections'
              ? 'Rejected lines'
              : (FLAG_LABELS[key.replace(/^flag-/, '').toUpperCase()] ?? key),
        passageId: p ? p.id : null,
        window: label,
        questions: 0,
        flags: 0,
        rejections: 0,
        total: 0,
        repeated: false,
        eventIds: [],
        expenseIds: [],
        quotes: [],
      };
      themes.set(key, t);
    }
    return t;
  };

  // Questions people asked (any channel), grouped by the passage they retrieved.
  const questions = events.filter((e) => e.intent === 'policy_question' && e.outcome !== 'refused');
  for (const e of questions) {
    const t = theme(String(e.meta?.topic ?? 'uncovered:none'));
    t.questions += 1;
    t.eventIds.push(e.id);
    const q = redactText(e.textRedacted).trim();
    if (q && !t.quotes.some((x) => x.text.toLowerCase() === q.toLowerCase()) && t.quotes.length < 3) {
      t.quotes.push({ id: e.id, text: q.slice(0, 160) });
    }
  }

  // What happened on claims: flags on lines created in the window, and rejections.
  const { from: f } = bounds(w);
  for (const l of lines) {
    if (l.createdAt >= f && l.createdAt < to) {
      for (const flag of l.flags) {
        const t = theme(flagTopic(flag, l.categoryCode));
        t.flags += 1;
        if (!t.expenseIds.includes(l.id)) t.expenseIds.push(l.id);
      }
    }
    if (l.status === 'rejected' && l.updatedAt >= f && l.updatedAt < to) {
      const t = theme('rejections');
      t.rejections += 1;
      if (!t.expenseIds.includes(l.id)) t.expenseIds.push(l.id);
      const note = redactText(l.reviewerNote ?? '').trim();
      if (note && t.quotes.length < 3) t.quotes.push({ id: l.id, text: note.slice(0, 160) });
    }
  }

  for (const t of themes.values()) {
    t.total = t.questions + t.flags + t.rejections;
    t.repeated = t.questions >= REPEAT_THRESHOLD;
  }

  // At most five themes, by volume; a repeated question always makes the cut.
  const sorted = [...themes.values()].sort((a, b) => b.total - a.total || b.questions - a.questions);
  let kept = sorted.slice(0, MAX_THEMES);
  for (const r of sorted.slice(MAX_THEMES).filter((t) => t.repeated)) {
    const drop = [...kept].reverse().find((t) => !t.repeated);
    if (!drop) break;
    kept = [...kept.filter((t) => t !== drop), r];
  }
  kept.sort((a, b) => b.total - a.total || b.questions - a.questions);

  return {
    themes: kept,
    stats: {
      window: label,
      questions: questions.length,
      notCovered: questions.filter((e) => e.outcome === 'not_covered').length,
      canonicalReused: questions.filter((e) => Boolean(e.meta?.canonicalId)).length,
      adviceRefused: events.filter(
        (e) => e.intent === 'advice_request' || (e.intent === 'policy_question' && e.outcome === 'refused'),
      ).length,
      expensesLogged: events.filter((e) => e.intent === 'log_expense' && e.outcome === 'confirmed').length,
      flaggedLines: lines.filter((l) => l.createdAt >= f && l.createdAt < to && l.flags.length > 0).length,
      rejectedLines: lines.filter((l) => l.status === 'rejected' && l.updatedAt >= f && l.updatedAt < to).length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pulse (≤250 words). Claude writes summary + 3 actions; code assembles.
// ─────────────────────────────────────────────────────────────────────────────

const PULSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'actions'],
  properties: {
    summary: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
  },
};

export function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function clipWords(text: string, max: number): string {
  const w = text.split(/\s+/).filter(Boolean);
  return w.length <= max ? text.trim() : `${w.slice(0, max).join(' ')}…`;
}

function themeLine(t: Theme, i: number): string {
  const parts = [
    t.questions ? `${t.questions} question${t.questions === 1 ? '' : 's'}` : '',
    t.flags ? `${t.flags} flagged line${t.flags === 1 ? '' : 's'}` : '',
    t.rejections ? `${t.rejections} rejected line${t.rejections === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `${i + 1}. ${t.label}: ${parts.join(', ')}${t.repeated ? ' (repeated question)' : ''}`;
}

function fallbackActions(top: Theme[]): string[] {
  const ideas = top.map((t) =>
    t.passageId
      ? `Publish the "${t.label}" explainer so the assistant answers it the same way every time.`
      : t.key === 'rejections'
        ? 'Review this week’s rejection reasons with managers so the policy notes cover them.'
        : `Add a source covering "${t.label}" so these questions stop going unanswered.`,
  );
  while (ideas.length < 3) ideas.push('Remind the team that the assistant can answer policy questions with sources.');
  return ideas.slice(0, 3);
}

export async function composePulse(orgName: string, g: Gathered): Promise<Pulse> {
  const top = g.themes.slice(0, TOP_THEMES);
  const repeated = g.themes.filter((t) => t.repeated);
  const quotes = top.flatMap((t) => t.quotes.slice(0, 1).map((q) => `"${q.text}"`)).slice(0, 3);

  let summary = '';
  let actions: string[] = [];
  let aiWritten = false;

  if (g.themes.length) {
    try {
      const res = await askJson<{ summary: string; actions: string[] }>({
        purpose: 'pulse',
        system:
          'You write the weekly expense-policy pulse for a finance team. Use only the numbers and quotes given. ' +
          'summary: at most 60 words, plain facts about what confused people this week. ' +
          'actions: exactly three short, concrete action ideas for the finance team (each under 25 words), about ' +
          'policy wording, explainers, or sources. Never give investment, tax-planning or returns advice.',
        prompt: JSON.stringify({
          window: g.stats.window,
          stats: g.stats,
          themes: g.themes.map((t) => ({
            label: t.label,
            questions: t.questions,
            flagged_lines: t.flags,
            rejected_lines: t.rejections,
            repeated: t.repeated,
            quotes: t.quotes.map((q) => q.text),
          })),
        }),
        effort: 'low',
        maxTokens: 4000,
        schema: PULSE_SCHEMA,
      });
      if (!res.refused) {
        summary = clipWords(res.value.summary, 60);
        actions = res.value.actions.map((a) => clipWords(a, 25)).filter((a) => a && !violatesScope(a));
        aiWritten = !violatesScope(summary);
        if (!aiWritten) summary = '';
      }
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
    }
  }

  if (!summary) {
    summary = g.themes.length
      ? `${g.stats.questions} policy question${g.stats.questions === 1 ? '' : 's'} and ${g.stats.flaggedLines} flagged line${g.stats.flaggedLines === 1 ? '' : 's'} this week. The biggest theme was "${top[0].label}".`
      : 'No policy questions or flagged lines this week.';
  }
  if (actions.length < 3) actions = [...actions, ...fallbackActions(top)].slice(0, 3);
  actions = actions.slice(0, 3);

  const build = (qs: string[], sum: string) =>
    [
      `Weekly pulse: ${orgName}, ${g.stats.window}`,
      '',
      `Top themes (${g.stats.window}):`,
      ...(top.length ? top.map(themeLine) : ['None this week.']),
      ...(repeated.length
        ? [
            '',
            `Asked ${REPEAT_THRESHOLD}+ times this week: ${repeated.map((t) => `${t.label} (${t.questions})`).join('; ')}.`,
          ]
        : []),
      ...(qs.length ? ['', `What people said: ${qs.join(' ')}`] : []),
      '',
      sum,
      '',
      'Action ideas:',
      ...actions.map((a, i) => `${i + 1}. ${a}`),
    ].join('\n');

  // Enforce the cap in code: drop quotes, then shorten the summary.
  let qs = quotes;
  let text = build(qs, summary);
  while (words(text) > PULSE_WORD_CAP && qs.length) {
    qs = qs.slice(0, -1);
    text = build(qs, summary);
  }
  if (words(text) > PULSE_WORD_CAP) {
    const over = words(text) - PULSE_WORD_CAP;
    summary = clipWords(summary, Math.max(10, words(summary) - over - 1));
    text = build(qs, summary);
  }

  return { text, wordCount: words(text), summary, actions, aiWritten };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Explainer for the top confusion (≤6 bullets, cited, last-checked date)
// ─────────────────────────────────────────────────────────────────────────────

const EXPLAINER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'bullets'],
  properties: {
    title: { type: 'string' },
    bullets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'passage_id'],
        properties: { text: { type: 'string' }, passage_id: { type: 'string' } },
      },
    },
  },
};

export async function composeExplainer(orgId: string, g: Gathered, passages: Passage[]): Promise<Explainer | null> {
  const topic = g.themes.slice(0, TOP_THEMES).find((t) => t.passageId);
  if (!topic?.passageId) return null;

  const main = passages.find((p) => p.id === topic.passageId)!;
  // The topic passage plus the closest related passages: up to two more from
  // the same source and two from the other sources, so the explainer can cite
  // both the company policy and the official rule.
  const related = search(passages, main.heading, 8)
    .hits.map((h) => h.passage)
    .filter((p) => p.id !== main.id);
  const pool: Passage[] = [
    main,
    ...related.filter((p) => p.sourceId === main.sourceId).slice(0, 2),
    ...related.filter((p) => p.sourceId !== main.sourceId).slice(0, 2),
  ];
  const byId = new Map(pool.map((p) => [p.id, p]));

  let title = `${main.heading}: what the rules say`;
  let bullets: { text: string; passageId: string }[] = [];
  let aiWritten = false;

  try {
    const res = await askJson<{ title: string; bullets: { text: string; passage_id: string }[] }>({
      purpose: 'explainer',
      system:
        'You write a short facts-only explainer for employees. Use ONLY the passages given. ' +
        `Write at most ${EXPLAINER_BULLET_CAP} bullets, each one sentence stating one fact from one passage, with that passage's id. ` +
        'Include facts from every source given if they are relevant. No advice, no recommendations, no opinions. ' +
        'title: under 10 words.',
      prompt: `People were confused about: ${topic.label}\n\nPassages:\n${pool
        .map((p) => `[${p.id}] (${p.sourceTitle} — ${p.heading}) ${p.text}`)
        .join('\n')}`,
      effort: 'low',
      maxTokens: 4000,
      schema: EXPLAINER_SCHEMA,
    });
    if (!res.refused) {
      bullets = res.value.bullets
        .filter(
          (b) =>
            byId.has(b.passage_id) &&
            b.text.trim() &&
            !violatesScope(b.text) &&
            ungroundedNumbers(b.text, [byId.get(b.passage_id)!.text]).length === 0,
        )
        .map((b) => ({ text: clipWords(b.text.trim(), 40), passageId: b.passage_id }));
      if (res.value.title.trim()) title = clipWords(res.value.title.trim(), 10);
      aiWritten = bullets.length > 0;
    }
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
  }

  // Fallback (or too few valid bullets): the passages themselves, verbatim.
  if (bullets.length < 2) {
    bullets = pool.map((p) => ({ text: p.text, passageId: p.id }));
    aiWritten = false;
  }
  bullets = bullets.slice(0, EXPLAINER_BULLET_CAP);

  const cited = bullets.map((b) => byId.get(b.passageId)!);
  const sources: Explainer['sources'] = [];
  for (const p of cited) {
    if (!sources.some((s) => s.url === p.url))
      sources.push({ title: p.sourceTitle, url: p.url, lastChecked: p.lastChecked });
  }
  const lastChecked = sources.map((s) => s.lastChecked).sort()[0];
  const already = await findCanonical(orgId, [topic.passageId]);

  return {
    topic: topic.passageId,
    title,
    bullets,
    sources: sources.slice(0, 2),
    lastChecked,
    aiWritten,
    alreadyCanonical: Boolean(already),
  };
}

export function explainerText(e: Explainer): string {
  return [
    e.title,
    ...e.bullets.map((b) => `• ${b.text}`),
    `Sources: ${e.sources.map((s) => `${s.title} (${s.url})`).join('; ')}`,
    `Last checked: ${e.lastChecked}`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Run: gather → compose → save drafts + pending actions. Writes nothing else.
// ─────────────────────────────────────────────────────────────────────────────

export async function runWeeklyLoop(
  orgId: string,
  opts: { trigger?: 'manual' | 'schedule'; window?: Window } = {},
): Promise<WeeklyRun> {
  const w = opts.window ?? lastSevenDays();
  const { passages } = await loadCorpus(orgId);
  const org = await getOrganisation(orgId);
  const g = await gather(orgId, w, passages);
  const pulse = await composePulse(org?.name ?? 'Your team', g);
  const explainer = await composeExplainer(orgId, g, passages);

  const runId = randomUUID();
  const [run] = await db
    .insert(weeklyRuns)
    .values({
      id: runId,
      orgId,
      windowStart: w.start,
      windowEnd: w.end,
      trigger: opts.trigger ?? 'manual',
      themes: g.themes,
      stats: g.stats,
      pulse: { ...pulse },
      explainer: explainer ? { ...explainer } : null,
    })
    .returning();

  const docBody = explainer ? `${pulse.text}\n\nExplainer\n${explainerText(explainer)}` : pulse.text;
  const actions: (typeof runActions.$inferInsert)[] = [
    {
      id: randomUUID(),
      orgId,
      runId,
      kind: 'append_doc',
      target: 'Append to the Weekly Log (Pulse → Weekly log)',
      payload: { title: `Weekly pulse ${g.stats.window}`, body: docBody },
    },
    {
      id: randomUUID(),
      orgId,
      runId,
      kind: 'email_draft',
      target: 'Save an email draft to the finance team (admins). Saved as a draft only; nothing is sent.',
      payload: { to: 'Finance team (all admins)', subject: `Expense policy pulse, ${g.stats.window}`, body: docBody },
    },
  ];
  if (explainer && !explainer.alreadyCanonical) {
    actions.push({
      id: randomUUID(),
      orgId,
      runId,
      kind: 'publish_explainer',
      target: `Publish as the canonical answer for "${explainer.title}". The assistant will reuse it for questions on this topic.`,
      payload: { ...explainer },
    });
  }
  await db.insert(runActions).values(actions);
  return run;
}
