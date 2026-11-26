/**
 * Weekly pulse (admins / finance):
 *
 * GET  /pulse                          latest run: themes, pulse, explainer, approval screen
 * GET  /pulse/runs/:id                 an earlier run
 * POST /pulse/run                      run the weekly loop now
 * POST /pulse/actions/:id/approve      write exactly this action's output
 * POST /pulse/actions/:id/reject
 * POST /pulse/actions/:id/edit         edit a pending doc entry / email draft
 * GET  /pulse/log                      Weekly Log entries and email drafts written so far
 * GET  /pulse/canonical                canonical answers the assistant reuses
 * POST /pulse/canonical/:id/retire
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../auth/middleware.js';
import { flash } from '../../auth/session.js';
import { runWeeklyLoop, type Explainer, type Pulse, type Theme } from '../../pulse/weekly.js';
import {
  actionsForRun,
  approveAction,
  editAction,
  getRun,
  latestRun,
  listOutputs,
  listRuns,
  rejectAction,
} from '../../pulse/approvals.js';
import { listCanonical, retireCanonical } from '../../pulse/canonical.js';
import type { WeeklyRun } from '../../db/schema.js';
import { ah, parseForm } from '../util.js';

export const pulseRouter = Router();
pulseRouter.use('/pulse', requireAuth, requireRole('admin'));

const orgOf = (req: Request) => req.user!.orgId;

async function renderRun(req: Request, run: WeeklyRun | null) {
  const runs = await listRuns(orgOf(req));
  const actions = run ? await actionsForRun(orgOf(req), run.id) : [];
  return {
    title: 'Weekly pulse',
    run,
    runs,
    themes: (run?.themes ?? []) as Theme[],
    stats: (run?.stats ?? {}) as Record<string, number | string>,
    pulse: (run?.pulse ?? null) as Pulse | null,
    explainer: (run?.explainer ?? null) as Explainer | null,
    actions,
  };
}

pulseRouter.get(
  '/pulse',
  ah(async (req, res) => {
    res.render('pulse/index', await renderRun(req, await latestRun(orgOf(req))));
  }),
);

pulseRouter.get(
  '/pulse/runs/:id',
  ah(async (req, res) => {
    res.render('pulse/index', await renderRun(req, await getRun(orgOf(req), String(req.params.id))));
  }),
);

pulseRouter.post(
  '/pulse/run',
  ah(async (req, res) => {
    const run = await runWeeklyLoop(orgOf(req), { trigger: 'manual' });
    flash(req, 'success', 'Weekly loop finished. Review each action below; nothing is written until you approve it.');
    res.redirect(303, `/pulse/runs/${run.id}`);
  }),
);

const back = (req: Request) => {
  const ref = req.get('referer');
  try {
    const u = ref ? new URL(ref) : null;
    return u && u.host === req.get('host') && u.pathname.startsWith('/pulse') ? u.pathname : '/pulse';
  } catch {
    return '/pulse';
  }
};

pulseRouter.post(
  '/pulse/actions/:id/approve',
  ah(async (req, res) => {
    const a = await approveAction(orgOf(req), String(req.params.id), req.user!.id);
    flash(
      req,
      'success',
      a.kind === 'publish_explainer'
        ? 'Explainer published. The assistant now reuses it as the canonical answer.'
        : a.kind === 'append_doc'
          ? 'Appended to the Weekly Log.'
          : 'Email draft saved (not sent).',
    );
    res.redirect(303, back(req));
  }),
);

pulseRouter.post(
  '/pulse/actions/:id/reject',
  ah(async (req, res) => {
    await rejectAction(orgOf(req), String(req.params.id), req.user!.id);
    flash(req, 'success', 'Rejected. Nothing was written.');
    res.redirect(303, back(req));
  }),
);

pulseRouter.post(
  '/pulse/actions/:id/edit',
  ah(async (req, res) => {
    const body = parseForm(z.object({ body: z.string().max(8000), subject: z.string().max(200).optional() }), req.body);
    await editAction(orgOf(req), String(req.params.id), body.body, body.subject);
    flash(req, 'success', 'Draft updated. It is still waiting for approval.');
    res.redirect(303, back(req));
  }),
);

pulseRouter.get(
  '/pulse/log',
  ah(async (req, res) => {
    const outputs = await listOutputs(orgOf(req));
    res.render('pulse/log', {
      title: 'Weekly log',
      docs: outputs.filter((o) => o.kind === 'doc_entry'),
      emails: outputs.filter((o) => o.kind === 'email_draft'),
    });
  }),
);

pulseRouter.get(
  '/pulse/canonical',
  ah(async (req, res) => {
    res.render('pulse/canonical', { title: 'Canonical answers', answers: await listCanonical(orgOf(req)) });
  }),
);

pulseRouter.post(
  '/pulse/canonical/:id/retire',
  ah(async (req, res) => {
    await retireCanonical(orgOf(req), String(req.params.id));
    flash(req, 'success', 'Retired. The assistant will draft fresh answers on this topic again.');
    res.redirect(303, '/pulse/canonical');
  }),
);
