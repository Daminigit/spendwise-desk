/**
 * src/pulse/scheduler.ts
 *
 * Runs the weekly loop with no one pressing a button.
 *
 *   - In the web process: set PULSE_SCHEDULE=weekly. Every hour it checks each
 *     organisation; on Mondays from 09:00 India time, an org whose last run is
 *     more than 6 days old gets a new run (trigger "schedule").
 *   - As a cron job: `npm run pulse` (or `node dist/pulse/cli.js`) runs the loop
 *     once for every organisation and exits.
 *
 * Either way the run only creates drafts and pending actions: nothing is
 * written or sent until an admin approves each action.
 */

import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { organisations, weeklyRuns } from '../db/schema.js';
import { logError } from '../log.js';
import { runWeeklyLoop } from './weekly.js';

const HOUR = 60 * 60 * 1000;

export function isRunTime(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * HOUR);
  return ist.getUTCDay() === 1 && ist.getUTCHours() >= 9;
}

export async function runDueOrgs(now = new Date(), force = false): Promise<string[]> {
  const orgs = await db.select({ id: organisations.id }).from(organisations);
  const ran: string[] = [];
  for (const { id } of orgs) {
    const [last] = await db
      .select({ createdAt: weeklyRuns.createdAt })
      .from(weeklyRuns)
      .where(eq(weeklyRuns.orgId, id))
      .orderBy(desc(weeklyRuns.createdAt))
      .limit(1);
    const due = force || !last || now.getTime() - last.createdAt.getTime() > 6 * 24 * HOUR;
    if (!due) continue;
    try {
      await runWeeklyLoop(id, { trigger: 'schedule' });
      ran.push(id);
    } catch (err) {
      logError(`[pulse:${id}]`, err);
    }
  }
  return ran;
}

export function startPulseScheduler(): void {
  if (process.env.PULSE_SCHEDULE !== 'weekly') return;
  const tick = () => {
    if (!isRunTime()) return;
    runDueOrgs().catch((err) => logError('[pulse:scheduler]', err));
  };
  setInterval(tick, HOUR).unref();
  tick();
  console.log('Weekly pulse scheduler on (Mondays from 09:00 IST).');
}
