/**
 * Response desk (admins / finance):
 *
 * GET  /desk                      queue of pending reply drafts: draft, citations, reviewer flags, routing note
 * GET  /desk/decided              drafts already approved or rejected
 * POST /desk/drafts/:id/approve   send exactly this draft to the person who asked
 * POST /desk/drafts/:id/edit      rewrite the draft (re-checked in code; still pending)
 * POST /desk/drafts/:id/reject    send nothing; the asker sees it was declined
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { flash } from '../../auth/session.js';
import { approveDraft, editDraft, listDrafts, rejectDraft } from '../../desk/desk.js';
import { ah, parseForm } from '../util.js';

export const deskRouter = Router();
deskRouter.use('/desk', requireAuth, requireRole('admin'));

const orgOf = (req: Request) => req.user!.orgId;

deskRouter.get(
  '/desk',
  ah(async (req, res) => {
    res.render('desk/index', { title: 'Response desk', tab: 'pending', drafts: await listDrafts(orgOf(req), 'pending') });
  }),
);

deskRouter.get(
  '/desk/decided',
  ah(async (req, res) => {
    res.render('desk/index', { title: 'Response desk', tab: 'decided', drafts: await listDrafts(orgOf(req), 'decided') });
  }),
);

deskRouter.post(
  '/desk/drafts/:id/approve',
  ah(async (req, res) => {
    await approveDraft(orgOf(req), String(req.params.id), req.user!.id);
    flash(req, 'success', 'Approved. The reply is now shown to the person who asked; nothing else changed.');
    res.redirect(303, `/desk#d-${req.params.id}`);
  }),
);

deskRouter.post(
  '/desk/drafts/:id/edit',
  ah(async (req, res) => {
    const body = parseForm(z.object({ text: z.string().max(1000) }), req.body);
    await editDraft(orgOf(req), String(req.params.id), body.text);
    flash(req, 'success', 'Edit saved and re-checked. It is still waiting for approval.');
    res.redirect(303, `/desk#d-${req.params.id}`);
  }),
);

deskRouter.post(
  '/desk/drafts/:id/reject',
  ah(async (req, res) => {
    const body = parseForm(z.object({ reason: z.string().max(300).optional() }), req.body);
    await rejectDraft(orgOf(req), String(req.params.id), req.user!.id, body.reason ?? '');
    flash(req, 'success', 'Rejected. Nothing was sent; the rest of the queue is unchanged.');
    res.redirect(303, '/desk');
  }),
);
