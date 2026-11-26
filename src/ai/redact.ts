/**
 * src/ai/redact.ts
 *
 * Removes personal identifiers from free text before it is sent to the model,
 * written to a log, or stored as agent state. This runs in code on every path
 * — it does not rely on the prompt asking the model to behave.
 *
 * Redacted: PAN, Aadhaar, card numbers (Luhn-checked), Indian mobile numbers,
 * bank account numbers (9–18 digits), email addresses, UPI ids, and Spendwise
 * connector tokens (`sw_…`).
 *
 * Kept on purpose: GSTINs. A GSTIN is a business's public tax id that expense
 * claims need, even though it contains the business's PAN in the middle.
 */

export type PiiKind = 'PAN' | 'AADHAAR' | 'CARD' | 'PHONE' | 'ACCOUNT' | 'EMAIL' | 'UPI' | 'TOKEN';

export interface RedactionResult {
  text: string;
  /** Kinds found, in the order first seen, without duplicates. */
  found: PiiKind[];
}

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi;

// Order matters: longer and more specific patterns run first, so a card number
// is not mistaken for an account number, nor an Aadhaar for a phone number.
const RULES: {
  kind: PiiKind;
  re: RegExp;
  accept?: (match: string) => boolean;
}[] = [
  { kind: 'TOKEN', re: /\bsw_[A-Za-z0-9_-]{8,}/g },
  { kind: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'UPI', re: /\b[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}\b/g },
  { kind: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/gi },
  {
    kind: 'CARD',
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (m) => luhnValid(m.replace(/\D/g, '')),
  },
  { kind: 'AADHAAR', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: 'PHONE', re: /(?:\+91[ -]?|\b0?)[6-9]\d{4}[ -]?\d{5}\b/g },
  { kind: 'ACCOUNT', re: /\b\d{9,18}\b/g },
];

/** 8+ single letters or digits separated by spaces, commas, dots or hyphens. */
const SPELLED_RUN = /\b(?:[A-Za-z0-9][\s,.-]+){7,}[A-Za-z0-9]\b/g;

export function redact(input: string): RedactionResult {
  const found: PiiKind[] = [];

  // Shield GSTINs behind placeholders that no rule can match, then restore them.
  const gstins: string[] = [];
  let text = input.replace(GSTIN_RE, (m) => `\u27e6${gstins.push(m) - 1}\u27e7`);

  // Identifiers read out one character at a time ("A, B, C, D, E, 1, 2, 3, 4, F",
  // as speech-to-text writes a spelled PAN): collapse the run and redact it if
  // the collapsed form is an identifier.
  text = text.replace(SPELLED_RUN, (m) => {
    const collapsed = m.replace(/[\s,.-]+/g, '');
    for (const { kind, re, accept } of RULES) {
      const full = new RegExp(`^(?:${re.source})$`, re.flags.replace('g', ''));
      if (full.test(collapsed) && (!accept || accept(collapsed))) {
        if (!found.includes(kind)) found.push(kind);
        return `[${kind}]`;
      }
    }
    return m;
  });

  for (const { kind, re, accept } of RULES) {
    text = text.replace(re, (m) => {
      if (accept && !accept(m)) return m;
      if (!found.includes(kind)) found.push(kind);
      return `[${kind}]`;
    });
  }

  text = text.replace(/\u27e6(\d+)\u27e7/g, (_, i: string) => gstins[Number(i)] ?? '');
  return { text, found };
}

/** Text with identifiers replaced, e.g. "PAN ABCDE1234F" → "PAN [PAN]". */
export function redactText(input: string): string {
  return redact(input).text;
}

export function containsPii(input: string): boolean {
  return redact(input).found.length > 0;
}

/** Redacts every string inside a JSON-like value (for logs and stored state). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
