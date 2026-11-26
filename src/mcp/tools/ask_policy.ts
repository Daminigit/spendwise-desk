import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { answerPolicyQuestion } from '../../assistant/policy.js';
import { isAdviceRequest, ADVICE_REFUSAL } from '../../assistant/guard.js';
import { recordEvent } from '../../assistant/events.js';
import { redactText } from '../../ai/redact.js';
import { run, type McpContext } from '../util.js';

export function registerAskPolicy(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'ask_policy',
    {
      title: 'Ask a policy question (cited)',
      description:
        "Answer a question about the organisation's expense policy or GST tax-invoice rules, from Spendwise's " +
        'source corpus only. Returns a short answer with source links and last-checked dates, or covered=false ' +
        'with the sources searched. Relay the answer and its source; never fill a gap from your own knowledge. ' +
        'Investment, tax-planning and returns questions are refused.',
      inputSchema: { question: z.string().min(3).max(500).describe('The question, in the user’s words.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ question }) =>
      run('ask_policy', async () => {
        const q = redactText(question);
        const base = {
          orgId: ctx.user.orgId,
          userId: ctx.user.id,
          channel: 'text' as const,
          intent: 'policy_question',
          text: q,
        };
        if (isAdviceRequest(q)) {
          await recordEvent({ ...base, outcome: 'refused', meta: { via: 'mcp' } });
          return { covered: false, refused: true, answer: ADVICE_REFUSAL, sources: [], searched: [] };
        }
        const a = await answerPolicyQuestion(ctx.user, q);
        await recordEvent({
          ...base,
          outcome: a.covered ? 'answered' : 'not_covered',
          meta: { via: 'mcp', sources: a.sources.map((s) => s.url) },
        });
        return {
          covered: a.covered,
          answer: a.reply,
          sources: a.sources.map((s) => ({ title: s.title, url: s.url, last_checked: s.lastChecked })),
          searched: a.searched,
        };
      }),
  );
}
