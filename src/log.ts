/**
 * src/log.ts
 *
 * Error logging that never writes personal data or secrets. Messages and stack
 * traces pass through the same redaction as AI prompts (PAN, Aadhaar, phone,
 * card, account numbers, emails, UPI ids, connector tokens). Use this instead
 * of console.error anywhere user input could end up in the message.
 */

import { redactText } from './ai/redact.js';

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function logError(label: string, err: unknown): void {
  console.error(redactText(label), redactText(describeError(err)));
}
