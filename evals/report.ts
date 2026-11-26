/**
 * evals/report.ts
 *
 * Builds evals/EVALS.md: the golden dataset, the adversarial tests and the
 * scores, item by item. It reads only evals/datasets.ts and the per-item data
 * that evals/run.ts records in evals/results/latest.json, so it never drifts
 * from what was actually run.
 *
 *   npm run eval          runs everything and writes this report at the end
 *   npm run eval:report   rewrites the report from the last results
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as D from './datasets.js';

interface Check {
  group: string;
  name: string;
  pass: boolean | null;
  detail: string;
  data?: unknown;
  required: boolean;
}

export interface EvalResult {
  ranAt: string;
  model: string | null;
  summary: { required: number; passed: number; failed: number; skipped: number };
  checks: Check[];
}

const cell = (v: unknown) =>
  String(v ?? '')
    .replace(/\|/g, '/')
    .replace(/\n/g, ' ')
    .trim();
const mark = (ok: boolean | null | undefined) => (ok === null || ok === undefined ? 'skipped' : ok ? 'pass' : '**FAIL**');
const table = (head: string[], rows: unknown[][]) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  '',
];

export function evalsReport(r: EvalResult): string {
  const find = (start: string) => r.checks.find((c) => c.name.startsWith(start));
  const rows = <T>(start: string) => (find(start)?.data ?? []) as T[];
  const score = (start: string) => {
    const c = find(start);
    return c ? `${mark(c.pass)}: ${c.detail}` : 'not run';
  };

  const groups: [string, string][] = [
    ['feasibility', 'Feasibility'],
    ['edits', 'Correctness of edits'],
    ['grounding', 'Grounding'],
    ['compliance', 'Compliance'],
    ['ai', 'Model-dependent (live model)'],
    ['iteration', 'Iteration'],
  ];

  // ── Golden set: retrieval + citation ─────────────────────────────────────
  type Cited = { q: string; covered: boolean; drafter: string; cited: string[]; ok: boolean };
  type Uncov = { q: string; web: boolean; mcp: boolean };
  const cited = new Map(rows<Cited>('Model-drafted answers').map((x) => [x.q, x]));
  const uncov = new Map(rows<Uncov>('Uncovered questions').map((x) => [x.q, x]));
  const golden = D.ROUTING.map((g) => {
    if (g.expect) {
      const a = cited.get(g.q);
      return [g.q, g.expect.join(', '), a ? (a.cited.join(', ') || 'nothing') : 'not run', a ? mark(a.ok) : 'skipped'];
    }
    const u = uncov.get(g.q);
    return [
      g.q,
      '(not covered: must say so)',
      u ? `web: ${u.web ? 'said not covered' : 'answered'}; MCP: ${u.mcp ? 'said not covered' : 'answered'}` : 'not run',
      u ? mark(u.web && u.mcp) : 'skipped',
    ];
  });

  type Intent = { text: string; expected: string; got: string; intentOk: boolean; slotsOk: boolean };
  const intents = rows<Intent>('Intent accuracy');
  type Voice = { file: string; heard: string; expected: string; got: string; intentOk: boolean; heardOk: boolean; piiRedacted: boolean | null };
  const voice = rows<Voice>('Voice');
  type Queued = { q: string; reply: string; covered: boolean; verdict: string; source: string; routing: string };
  const queue = rows<Queued>('Every queued question');

  // ── Adversarial ──────────────────────────────────────────────────────────
  type Refusal = { q: string; channel: string; refused: boolean };
  const refusals = rows<Refusal>('Advice and return-figure');
  const refusedBy = (q: string, ch: string) => {
    const xs = refusals.filter((x) => x.q === q && x.channel === ch);
    return xs.length ? `${xs.filter((x) => x.refused).length}/${xs.length}` : 'see score';
  };
  type Planted = { case: string; verdict: string; blocked: string[]; ok: boolean };
  const planted = rows<Planted>('The reviewer rejects');
  type Guard = { missed: string[]; wronglyRefused: string[] };
  const guard = (find('Advice guard')?.data ?? {}) as Record<string, Guard>;
  const v3 = guard.v3 ?? { missed: [], wronglyRefused: [] };
  type Sample = { loop: string; claim: string; tracesTo: string; ok: boolean; why: string };
  const sampled = rows<Sample>('15 sampled claims');
  const outputs = (find('Recommendation / return-figure')?.data ?? []) as string[];

  const lines = [
    '# Evals report: golden dataset, adversarial tests and scores',
    '',
    `Run ${r.ranAt.slice(0, 16).replace('T', ' ')} UTC · model: ${r.model ?? 'none (model-dependent checks skipped)'}`,
    '',
    `**Required checks: ${r.summary.passed}/${r.summary.required} passed**${r.summary.skipped ? ` · ${r.summary.skipped} skipped` : ''}. ` +
      'Every check runs over the assembled system: the database, both loops, the HTTP server and an MCP client. ' +
      'The inputs are hand-labelled in [`datasets.ts`](datasets.ts) before running; the harness is [`run.ts`](run.ts). ' +
      'All personal numbers in the tests are made up.',
    '',
    'Reproduce: `EVAL_DATABASE_URL=postgresql://localhost/spendwise_eval npm run eval` (with `GROQ_API_KEY` for the model-dependent checks).',
    '',
    '## Scores',
    '',
    ...table(
      ['Area', 'Passed'],
      groups.map(([g, title]) => {
        const cs = r.checks.filter((c) => c.group === g);
        return [title, `${cs.filter((c) => c.pass).length}/${cs.length}`];
      }),
    ),
    ...table(
      ['Result', 'Check', 'Detail'],
      r.checks.map((c) => [mark(c.pass) + (c.required ? '' : ' (not required)'), c.name, c.detail]),
    ),
    '## 1. Golden dataset',
    '',
    `### 1a. Policy questions → expected source passage (${D.ROUTING.length} questions)`,
    '',
    'Each question is labelled with the passage(s) an answer must cite, or marked as not covered by any source. ' +
      'Covered questions are answered by the live model and scored on whether it cites an expected passage. ' +
      'Uncovered questions must come back as "not covered", naming what was searched, on the web assistant and over MCP.',
    '',
    `Score: ${score('Model-drafted answers')} · uncovered: ${score('Uncovered questions')}`,
    '',
    ...table(['Question', 'Expected passage', 'Got', 'Result'], golden),
    `### 1b. Response-desk queue (${D.QUEUE.length} questions)`,
    '',
    'Each question goes through the three agents, the orchestrator and the reviewer, and must end as a cited draft or an explicit "not covered", waiting for a person.',
    '',
    `Score: ${score('Every queued question')} · ${score('Each question runs through')}`,
    '',
    ...table(
      ['Question', 'Draft', 'Cites', 'Reviewer'],
      queue.map((x) => [x.q, x.reply, x.covered ? x.source : 'not covered', x.verdict]),
    ),
    `### 1c. Intent: spoken and Hinglish utterances (${intents.length || D.INTENTS.length})`,
    '',
    `Score: ${score('Intent accuracy')}`,
    '',
    ...table(
      ['Utterance', 'Expected', 'Got', 'Result'],
      (intents.length ? intents : D.INTENTS.map((i) => ({ text: i.text, expected: i.intent, got: '', intentOk: null, slotsOk: null }))).map(
        (x) => [x.text, x.expected, x.got, mark(x.intentOk as boolean | null)],
      ),
    ),
    `### 1d. Voice: recorded clips → Whisper → intent (${D.VOICE.length})`,
    '',
    `Score: ${score('Voice')}`,
    '',
    ...table(
      ['Clip', 'Whisper heard (redacted)', 'Expected', 'Got', 'Result'],
      voice.map((x) => [
        x.file,
        x.heard,
        x.expected,
        x.got,
        mark(x.intentOk && x.heardOk && x.piiRedacted !== false),
      ]),
    ),
    '## 2. Adversarial tests',
    '',
    `### 2a. Advice and return-figure requests (${D.ADVICE.length + D.RETURN_FIGURES.length} requests × 2 repeats × 2 channels)`,
    '',
    'Each must be refused every time, on the web assistant and over MCP, and never appear in the weekly pulse.',
    '',
    `Score: ${score('Advice and return-figure')} · ${score('Refused requests never appear')}`,
    '',
    ...table(
      ['Kind', 'Request', 'Web assistant refused', 'MCP refused'],
      [
        ...D.ADVICE.map((q) => ['advice', q, refusedBy(q, 'assistant'), refusedBy(q, 'mcp')]),
        ...D.RETURN_FIGURES.map((q) => ['return figure', q, refusedBy(q, 'assistant'), refusedBy(q, 'mcp')]),
      ],
    ),
    `### 2b. Ordinary messages that must not be refused (${D.BENIGN.length})`,
    '',
    `False-positive check for the advice guard. Current guard wrongly refused: ${v3.wronglyRefused.length ? v3.wronglyRefused.map((m) => `"${m}"`).join(', ') : 'none'}.`,
    '',
    ...table(['Message', 'Result'], D.BENIGN.map((m) => [m, mark(!v3.wronglyRefused.includes(m))])),
    `### 2c. Personal data: PAN, bank account, phone (${D.PII_MESSAGES.length} messages × 2 repeats × 2 channels, plus a pulse edit and an error path)`,
    '',
    'After sending these, every table (questions, reply drafts and the agents\' notes, weekly actions, outputs, canonical answers, audit log) and every captured log line is searched for the raw values.',
    '',
    `Score: ${score('PAN, account and phone')} · ${score('Nothing sensitive reached')}`,
    '',
    ...table(['Message (made-up values)'], D.PII_MESSAGES.map((m) => [m])),
    `### 2d. Planted bad drafts the reviewer must stop (${planted.length || 6})`,
    '',
    'Fixed drafts are pushed through the real agents, orchestrator and reviewer. Each bad one must be rejected and its approval blocked; the grounded control must be approvable.',
    '',
    `Score: ${score('The reviewer rejects')}`,
    '',
    ...table(
      ['Case', 'Reviewer verdict', 'Why it was blocked', 'Result'],
      planted.map((x) => [x.case, x.verdict, x.blocked.join(' ') || '(nothing blocked)', mark(x.ok)]),
    ),
    '### 2e. Recommendation and return-figure text in model output',
    '',
    `Score: ${score('Recommendation / return-figure')}`,
    '',
    ...(outputs.length ? table(['Model output that must be blocked'], outputs.map((o) => [o])) : []),
    '## 3. Grounding sample (15 claims across both loops)',
    '',
    `Score: ${score('15 sampled claims')}`,
    '',
    ...table(
      ['Loop', 'Claim', 'Traces to', 'Result'],
      sampled.map((s) => [s.loop, s.claim.slice(0, 160), s.tracesTo, s.ok ? 'pass' : `**FAIL**: ${s.why}`]),
    ),
    '## 4. Correctness of edits (state diffed before and after)',
    '',
    ...table(
      ['Result', 'Check', 'Detail'],
      r.checks.filter((c) => c.group === 'edits').map((c) => [mark(c.pass), c.name, c.detail]),
    ),
    '## 5. Iteration',
    '',
    ...table(
      ['Result', 'Change', 'Detail'],
      r.checks.filter((c) => c.group === 'iteration').map((c) => [mark(c.pass), c.name, c.detail]),
    ),
    'Earlier versions are kept in [`legacy/`](legacy). The routing questions overlap those used while tuning retrieval, so the retrieval score overstates how it does on new phrasings.',
    '',
  ];
  return lines.join('\n');
}

export function writeEvalsReport(dir: string, result: EvalResult): void {
  writeFileSync(path.join(dir, 'EVALS.md'), evalsReport(result));
}

// `npm run eval:report`: rebuild from the last results without re-running.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const result = JSON.parse(readFileSync(path.join(dir, 'results', 'latest.json'), 'utf8')) as EvalResult;
  writeEvalsReport(dir, result);
  console.log('Wrote evals/EVALS.md');
}
