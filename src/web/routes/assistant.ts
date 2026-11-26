/**
 * GET  /assistant           voice + text assistant page
 * POST /assistant/message   { text, channel, pending } → reply (never writes claims)
 * POST /assistant/confirm   { token, channel }         → writes exactly the previewed action
 * POST /assistant/cancel    { intent, channel }        → logs that the preview was dropped
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { isAiConfigured } from '../../ai/claude.js';
import { interpret, INTENTS, type Pending } from '../../assistant/interpret.js';
import { confirmAction } from '../../assistant/actions.js';
import { recordEvent } from '../../assistant/events.js';
import { ah, parseForm } from '../util.js';

export const assistantRouter = Router();
assistantRouter.use('/assistant', requireAuth);

const channel = z.enum(['voice', 'text']).default('text');
const nullableStr = z.string().max(500).nullable().optional();

const pendingSchema = z
  .object({
    intent: z.enum(['log_expense', 'approve_claim', 'reject_claim']),
    expense: z
      .object({
        amount: z.number().nullable(),
        date: z.string().max(10).nullable(),
        merchant: nullableStr.transform((v) => v ?? null),
        category: z.string().max(100).nullable(),
        description: nullableStr.transform((v) => v ?? null),
        claim: z.string().max(100).nullable(),
        payment_method: z.enum(['personal_card', 'cash', 'upi', 'company_card']).nullable(),
      })
      .optional(),
    claimId: z.string().max(100).nullable().optional(),
    note: nullableStr,
  })
  .nullable()
  .optional();

const messageSchema = z.object({
  text: z.string().max(1000),
  channel,
  pending: pendingSchema,
});

assistantRouter.get('/assistant', (_req, res) => {
  res.render('assistant/index', { title: 'Assistant', aiReady: isAiConfigured() });
});

assistantRouter.post(
  '/assistant/message',
  ah(async (req, res) => {
    if (!isAiConfigured())
      return res.status(503).json({ error: 'The assistant is not configured (ANTHROPIC_API_KEY).' });
    const body = parseForm(messageSchema, req.body);
    const reply = await interpret({
      user: req.user!,
      text: body.text,
      channel: body.channel,
      pending: (body.pending ?? null) as Pending | null,
    });
    res.json(reply);
  }),
);

assistantRouter.post(
  '/assistant/confirm',
  ah(async (req, res) => {
    const body = parseForm(z.object({ token: z.string().max(4000), channel }), req.body);
    res.json(await confirmAction(req.user!, body.token, body.channel));
  }),
);

assistantRouter.post(
  '/assistant/cancel',
  ah(async (req, res) => {
    const body = parseForm(z.object({ intent: z.enum(INTENTS), channel }), req.body);
    await recordEvent({
      orgId: req.user!.orgId,
      userId: req.user!.id,
      channel: body.channel,
      intent: body.intent,
      outcome: 'cancelled',
      text: 'preview cancelled',
    });
    res.json({ ok: true });
  }),
);
