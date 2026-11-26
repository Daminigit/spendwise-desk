/**
 * src/pulse/cli.ts — run the weekly loop once for every organisation, then exit.
 * Usage: npm run pulse           (dev, tsx)
 *        node dist/pulse/cli.js  (production cron)
 */

import '../env.js';
import { runDueOrgs } from './scheduler.js';

runDueOrgs(new Date(), true)
  .then((ids) => {
    console.log(
      `Weekly loop ran for ${ids.length} organisation${ids.length === 1 ? '' : 's'}. Drafts await approval at /pulse.`,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error('Weekly loop failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
