/**
 * GET  /assistant           voice + text assistant page
 * POST /assistant/message   { text, channel, pending } → reply (never writes claims)
 * POST /assistant/confirm   { token, channel }         → writes exactly the previewed action
 * POST /assistant/cancel    { intent, channel }        → logs that the preview was dropped
 * POST /assistant/transcribe multipart audio           → { text } via Whisper (audio is not stored)
 * GET  /assistant/questions                           → the caller's recent policy questions and approved replies
 */

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import {
  AiUnavailableError,
  isAiConfigured,
  isTranscriptionConfigured,
  modelLabel,
  transcribe,
} from '../../ai/model.js';
import { DomainError } from '../../domain/errors.js';
import { interpret, INTENTS, type Pending } from '../../assistant/interpret.js';
import { confirmAction } from '../../assistant/actions.js';
import { recordEvent } from '../../assistant/events.js';
import { myQuestions } from '../../desk/desk.js';
import { ah, parseForm } from '../util.js';

export const assistantRouter = Router();
assistantRouter.use('/assistant', requireAuth);

const channel = z.enum(['voice', 'text']).default('text');
const nullableStr = z.string().max(500).nullable().optional();

const pendingSchema = z
  .object({
    intent: z.enum(['log_expense', 'approve_claim', 'reject_claim', 'submit_claim']),
    expense: z
      .object({
        amount: z.number().nullable(),
        date: z.string().max(10).nullable(),
        merchant: nullableStr.transform((v) => v ?? null),
        category: z.string().max(100).nullable(),
        description: nullableStr.transform((v) => v ?? null),
        claim: z.string().max(100).nullable(),
        payment_method: z.enum(['personal_card', 'cash', 'upi', 'company_card']).nullable(),
        gstin: z.string().max(20).nullable().optional(),
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
  res.render('assistant/index', {
    title: 'Assistant',
    aiReady: isAiConfigured(),
    whisper: isTranscriptionConfigured(),
    modelName: modelLabel(),
  });
});

assistantRouter.get(
  '/assistant/questions',
  ah(async (req, res) => {
    res.json({ questions: await myQuestions(req.user!) });
  }),
);

assistantRouter.post(
  '/assistant/message',
  ah(async (req, res) => {
    if (!isAiConfigured())
      return res.status(503).json({ error: 'The assistant is not configured (GROQ_API_KEY or ANTHROPIC_API_KEY).' });
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

// Voice clips are short; 10 MB is far above a 30-second recording.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 },
});
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|mpeg|mp3|wav|x-wav|m4a|x-m4a|aac|flac)(;.*)?$/i;
const EXT: Record<string, string> = {
  webm: 'webm',
  ogg: 'ogg',
  mp4: 'mp4',
  mpeg: 'mp3',
  mp3: 'mp3',
  wav: 'wav',
  'x-wav': 'wav',
  m4a: 'm4a',
  'x-m4a': 'm4a',
  aac: 'm4a',
  flac: 'flac',
};

assistantRouter.post(
  '/assistant/transcribe',
  audioUpload.single('audio'),
  ah(async (req, res) => {
    if (!isTranscriptionConfigured()) return res.status(503).json({ error: 'Voice transcription is not configured.' });
    const file = req.file;
    if (!file || !file.buffer.length) throw new DomainError('No audio received.', 'invalid');
    if (!AUDIO_TYPES.test(file.mimetype)) throw new DomainError('That is not an audio recording.', 'invalid');
    const sub = file.mimetype.split(';')[0].split('/')[1].toLowerCase();
    // The audio goes to Whisper once and is dropped; it is never written to disk or the database.
    try {
      const text = await transcribe(file.buffer, `voice.${EXT[sub] ?? 'webm'}`);
      res.json({ text: text.slice(0, 1000) });
    } catch (err) {
      if (err instanceof AiUnavailableError) return res.status(503).json({ error: err.message });
      throw err;
    }
  }),
);
