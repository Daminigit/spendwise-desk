/**
 * evals/sources-manifest.ts
 *
 * Builds SOURCES.md: every source the assistant may cite, with its URL,
 * publisher, last-checked date and every passage id an answer can point to.
 * It is generated from the same corpus the app loads (src/corpus/), for the
 * demo organisation, so the manifest matches what the answers cite.
 */

import { writeFileSync } from 'fs';
import type { SourceDoc } from '../src/corpus/public-sources.js';

const cell = (v: string) => v.replace(/\|/g, '/').replace(/\n/g, ' ').trim();

export function sourcesManifest(sources: SourceDoc[], appUrl: string, generatedOn: string): string {
  const total = sources.reduce((n, s) => n + s.passages.length, 0);
  const isCompany = (s: SourceDoc) => s.id === 'company-policy';
  const link = (s: SourceDoc) => (isCompany(s) ? `${appUrl.replace(/\/$/, '')}/settings/policy` : s.url);
  return [
    '# Source manifest',
    '',
    `Generated ${generatedOn} by \`npm run eval\` from the corpus the app loads ([\`src/corpus/\`](src/corpus)). ` +
      `${sources.length} sources, ${total} passages. Live view with the same ids: [${appUrl.replace(/\/$/, '')}/sources](${appUrl.replace(/\/$/, '')}/sources).`,
    '',
    '**Rules.** Public, official sources only: no blogs, no third-party summaries, no app back-end screenshots. ' +
      'Each passage is a short plain-English paraphrase of its source that says only what the source says. ' +
      'Every factual claim in a reply cites one passage id below, with its source link and last-checked date. ' +
      'A reply whose numbers are not in the cited passage is rejected by the reviewer in code.',
    '',
    '## Sources',
    '',
    '| # | Source | Publisher | URL | Last checked | Passages | Used for |',
    '|---|---|---|---|---|---|---|',
    ...sources.map((s, i) =>
      `| ${i + 1} | ${cell(s.title)} | ${cell(s.publisher)} | ${link(s)} | ${isCompany(s) ? `${s.lastChecked} (read live from the database on every answer)` : s.lastChecked} | ${s.passages.length} | ${
        isCompany(s)
          ? 'The organisation\'s own expense rules: receipt and GSTIN thresholds, weekend rule, how flags work, category limits, policy notes'
          : 'What a GST tax invoice must show: supplier and recipient details, HSN/SAC, value and tax, place of supply, signature'
      } |`,
    ),
    '',
    ...sources.flatMap((s) => [
      `## ${s.title}`,
      '',
      `${s.publisher} · ${link(s)} · last checked ${s.lastChecked}` +
        (isCompany(s)
          ? '. This source is the policy an admin sets in the app (Settings → Policy); the passages below are generated from it, so their figures change when the policy changes. Shown here for the demo organisation.'
          : '.'),
      '',
      '| Passage id | Heading | Text |',
      '|---|---|---|',
      ...s.passages.map((p) => `| \`${p.id}\` | ${cell(p.heading)} | ${cell(p.text)} |`),
      '',
    ]),
    '## Deliberately not included',
    '',
    'These could not be verified on an official page on 2026-11-26, so questions about them come back as "not covered", naming the sources searched:',
    '',
    '- CGST Act section 17(5), blocked input tax credit (CBIC\'s Act page returned 404).',
    '- The structure of a GSTIN.',
    '',
    '## How to add a source',
    '',
    'Read the official page, add it to [`src/corpus/public-sources.ts`](src/corpus/public-sources.ts) with passages that say only what the page says, set `lastChecked` to the day you read it, and re-run `npm run eval` (which regenerates this file).',
    '',
  ].join('\n');
}

export function writeSourcesManifest(file: string, sources: SourceDoc[], appUrl: string, generatedOn: string): void {
  writeFileSync(file, sourcesManifest(sources, appUrl, generatedOn));
}
