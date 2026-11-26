/**
 * src/corpus/corpus.ts
 *
 * The full source corpus for one organisation: the company's own expense
 * policy (read live from the database, so it is always current) plus the
 * public official sources. Every passage carries its source URL and the date
 * it was last checked.
 */

import { getOrganisation, getPolicy } from '../domain/org.js';
import { formatINR } from '../domain/money.js';
import { appUrl } from '../config.js';
import { PUBLIC_SOURCES, type SourceDoc } from './public-sources.js';

export interface Passage {
  id: string;
  sourceId: string;
  sourceTitle: string;
  url: string;
  lastChecked: string;
  heading: string;
  text: string;
}

export function todayIso(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

export async function companyPolicySource(orgId: string, today = todayIso()): Promise<SourceDoc> {
  const [{ policy, categories }, org] = await Promise.all([getPolicy(orgId), getOrganisation(orgId)]);
  const name = org?.name ?? 'Company';
  const active = categories.filter((c) => c.active);

  const passages: SourceDoc['passages'] = [
    {
      id: 'policy-receipts',
      heading: 'Receipts',
      text: `A receipt image is required for any expense above ${formatINR(policy.receiptRequiredAboveMinor)}. A claim missing a required receipt is flagged when it is submitted.`,
    },
    {
      id: 'policy-gstin',
      heading: 'Supplier GSTIN',
      text: `The supplier's GSTIN is required for any expense above ${formatINR(policy.gstinRequiredAboveMinor)}. A missing or invalid GSTIN is flagged for the approver.`,
    },
    {
      id: 'policy-weekend',
      heading: 'Weekend spend',
      text: policy.allowWeekendSpend
        ? 'Weekend spend is allowed without a flag.'
        : 'Expenses dated on a Saturday or Sunday are allowed but flagged for the approver to check.',
    },
    {
      id: 'policy-flags',
      heading: 'How policy checks work',
      text:
        'Policy checks never block a claim. They add flags (over item limit, over daily limit, missing receipt, missing or invalid GSTIN, ' +
        'GST mismatch, weekend, outside trip dates, possible duplicate) that the approving manager sees before deciding.',
    },
    {
      id: 'policy-categories',
      heading: 'Expense categories',
      text: `The expense categories are: ${active.map((c) => c.name).join(', ')}.`,
    },
    ...active.map((c) => ({
      id: `policy-limit-${c.code.toLowerCase()}`,
      heading: `${c.name} limits`,
      text:
        `${c.name} (${c.code}): ` +
        (c.perItemLimitMinor == null ? 'no per-item limit' : `per-item limit ${formatINR(c.perItemLimitMinor)}`) +
        '; ' +
        (c.perDayLimitMinor == null ? 'no daily limit' : `daily limit ${formatINR(c.perDayLimitMinor)}`) +
        '. Spending over a limit is flagged for the approver, not blocked.',
    })),
  ];
  if (policy.notes.trim()) {
    passages.push({ id: 'policy-notes', heading: 'Policy notes', text: policy.notes.trim().slice(0, 2000) });
  }

  return {
    id: 'company-policy',
    title: `${name} expense policy`,
    publisher: name,
    url: `${appUrl()}/settings/policy`,
    lastChecked: today,
    passages,
  };
}

export async function loadCorpus(
  orgId: string,
  today = todayIso(),
): Promise<{ sources: SourceDoc[]; passages: Passage[] }> {
  const sources = [await companyPolicySource(orgId, today), ...PUBLIC_SOURCES];
  const passages = sources.flatMap((s) =>
    s.passages.map((p) => ({
      id: p.id,
      sourceId: s.id,
      sourceTitle: s.title,
      url: s.url,
      lastChecked: s.lastChecked,
      heading: p.heading,
      text: p.text,
    })),
  );
  return { sources, passages };
}
