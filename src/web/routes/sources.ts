/**
 * GET /sources   every source the assistant can cite, with its passages,
 *                link and last-checked date (the "sources panel").
 */

import { Router } from 'express';
import { requireAuth } from '../../auth/middleware.js';
import { loadCorpus } from '../../corpus/corpus.js';
import { ah } from '../util.js';

export const sourcesRouter = Router();

sourcesRouter.get(
  '/sources',
  requireAuth,
  ah(async (req, res) => {
    const { sources } = await loadCorpus(req.user!.orgId);
    res.render('sources/index', { title: 'Sources', sources });
  }),
);
