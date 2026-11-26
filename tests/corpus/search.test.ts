import { describe, expect, it } from 'vitest';
import { search, tokenize } from '../../src/corpus/search.js';
import { capSentences } from '../../src/assistant/policy.js';
import type { Passage } from '../../src/corpus/corpus.js';

const p = (id: string, heading: string, text: string): Passage => ({
  id,
  sourceId: 's',
  sourceTitle: 'Test policy',
  url: 'https://example.test',
  lastChecked: '2026-11-26',
  heading,
  text,
});

const passages = [
  p('lodge', 'Lodging limits', 'Lodging (LODGE): per-item limit ₹6,000.00; no daily limit.'),
  p('meals', 'Meals limits', 'Meals (MEALS): per-item limit ₹1,500.00; daily limit ₹2,500.00.'),
  p('receipts', 'Receipts', 'A receipt image is required for any expense above ₹500.00.'),
  p('weekend', 'Weekend spend', 'Expenses dated on a Saturday or Sunday are flagged for the approver.'),
  p('invoice', 'Supplier details', 'A tax invoice must show the name, address and GSTIN of the supplier.'),
];

describe('corpus search', () => {
  it('maps everyday words to the policy words', () => {
    expect(search(passages, 'what is the hotel limit?').hits[0].passage.id).toBe('lodge');
    expect(search(passages, 'how much can I spend on dinner').hits[0].passage.id).toBe('meals');
    expect(search(passages, 'can I claim a cab on sunday').hits.map((h) => h.passage.id)).toContain('weekend');
    expect(search(passages, 'do I need a bill for 300 rupees').hits[0].passage.id).toBe('receipts');
    expect(search(passages, 'what should the GST invoice show').hits[0].passage.id).toBe('invoice');
  });

  it('returns nothing for questions the corpus does not cover', () => {
    expect(search(passages, 'can I expense a gym membership').hits).toEqual([]);
    expect(search(passages, 'what is the weather').hits).toEqual([]);
  });

  it('drops stopwords, including common Hinglish ones', () => {
    expect(tokenize('Kya hotel ka limit hai?')).toEqual(['hotel', 'limit']);
  });

  it('caps answers at three sentences without splitting amounts', () => {
    expect(capSentences('Limit is ₹1,500.00. Two. Three. Four.', 3)).toBe('Limit is ₹1,500.00. Two. Three.');
  });
});
