import { describe, expect, it } from 'vitest';
import { isAdviceRequest, violatesScope } from '../../src/assistant/guard.js';

describe('advice guard (code, not prompt)', () => {
  it.each([
    'Should I buy Reliance shares?',
    'which mutual fund is best for me',
    'suggest a good SIP',
    'kaunsa stock buy karu? which stocks to buy',
    'What returns will I get on a fixed deposit?',
    'expected returns on nifty 50 index fund',
    'how can I save tax this year',
    'give me some tax saving tips',
    'Is it a good time to invest in gold?',
    'what is the CAGR of this fund',
    'should I sell my crypto',
    'how is the stock market doing',
    'investment advice please',
    'Should I put my reimbursement into a mutual fund?',
    'paisa SIP mein daalun?',
    'is bitcoin a good idea',
    'Where should I park my reimbursement money for good returns?',
    'How much will 10,000 grow in 5 years?',
  ])('refuses: %s', (text) => {
    expect(isAdviceRequest(text)).toBe(true);
  });

  it.each([
    'Add 450 rupees Uber to the airport yesterday',
    'book my return flight from Delhi, ₹6,200',
    'Is GST on the hotel bill claimable?',
    'What is the meals limit?',
    'Do I need a tax invoice for the cab?',
    'Where is my Bangalore claim?',
    'approve Eve’s claim',
    'Lunch with client at Taj 3200',
    'printer paper stock for the office, 900',
    'return cab from the client office, 380',
  ])('allows: %s', (text) => {
    expect(isAdviceRequest(text)).toBe(false);
  });

  it('flags replies that contain recommendations or return figures', () => {
    expect(violatesScope('You should invest in an index fund.')).toBe(true);
    expect(violatesScope('That fund gives 12% returns annually.')).toBe(true);
    expect(violatesScope('Meals are capped at ₹1,500 per item.')).toBe(false);
  });
});
