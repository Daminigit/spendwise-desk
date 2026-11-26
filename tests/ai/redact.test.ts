import { describe, expect, it } from 'vitest';
import { containsPii, redact, redactDeep, redactText } from '../../src/ai/redact.js';

describe('redact', () => {
  it.each([
    ['PAN', 'my pan is ABCDE1234F please', 'my pan is [PAN] please'],
    ['PAN lower case', 'pan abcde1234f', 'pan [PAN]'],
    ['Aadhaar spaced', 'aadhaar 2345 6789 0123', 'aadhaar [AADHAAR]'],
    ['Aadhaar plain', 'id 234567890123', 'id [AADHAAR]'],
    ['card (Luhn)', 'card 4111 1111 1111 1111 declined', 'card [CARD] declined'],
    ['phone +91', 'call +91 98765 43210', 'call [PHONE]'],
    ['phone plain', 'call 9876543210 now', 'call [PHONE] now'],
    ['phone with 0', 'call 09876543210', 'call [PHONE]'],
    ['account number', 'a/c 50100123456781 hdfc', 'a/c [ACCOUNT] hdfc'],
    ['email', 'mail riya.k@acme.co.in', 'mail [EMAIL]'],
    ['UPI id', 'paid to riya@okhdfcbank', 'paid to [UPI]'],
    [
      'PAN spelled out (speech-to-text)',
      'My pan is A, B, C, D, E, 1, 2, 3, 4, F. What is the limit?',
      'My pan is [PAN]. What is the limit?',
    ],
    ['phone read digit by digit', 'call 9 8 7 6 5 4 3 2 1 0 please', 'call [PHONE] please'],
    ['connector token', 'url /mcp/sw_abcdefghij1234567890', 'url /mcp/[TOKEN]'],
  ])('redacts %s', (_label, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('reports each kind found once, in order', () => {
    const r = redact('PAN ABCDE1234F, phone 9876543210, other PAN PQRSX6789Z');
    expect(r.found).toEqual(['PAN', 'PHONE']);
  });

  it('leaves ordinary short words and initials alone', () => {
    const text = 'Book a cab for A and B at 5 pm, row 3, seat 4';
    expect(redactText(text)).toBe(text);
  });

  it('keeps GSTINs, amounts, dates and claim details intact', () => {
    const text = 'Hotel ₹4,500 on 2026-11-20, GSTIN 29ABCDE1234F1Z5, invoice INV-2026-0042, 3 nights';
    expect(redactText(text)).toBe(text);
    expect(containsPii(text)).toBe(false);
  });

  it('treats a 16-digit number that fails Luhn as an account number, not a card', () => {
    expect(redactText('ref 1234567812345678')).toBe('ref [ACCOUNT]');
  });

  it('redacts nested values for logs and stored state', () => {
    const out = redactDeep({
      note: 'PAN ABCDE1234F',
      items: ['ok', 'ph 9876543210'],
      amount: 450,
    });
    expect(out).toEqual({
      note: 'PAN [PAN]',
      items: ['ok', 'ph [PHONE]'],
      amount: 450,
    });
  });
});
