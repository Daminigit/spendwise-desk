import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { myQuestion, myQuestions } from '../../desk/desk.js';
import { run, type McpContext } from '../util.js';

export function registerGetPolicyAnswer(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'get_policy_answer',
    {
      title: 'Get the reviewed answer to a policy question',
      description:
        'Check a policy question sent with ask_policy. status is "in_review" (finance has not decided yet), ' +
        '"answered" (the approved reply, with its source links and last-checked dates; relay it as written), or ' +
        '"declined" (finance did not send an answer). Without question_id, lists the caller’s recent questions.',
      inputSchema: { question_id: z.string().max(100).optional().describe('The question_id ask_policy returned.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ question_id }) =>
      run('get_policy_answer', async () => {
        const shape = (q: Awaited<ReturnType<typeof myQuestion>>) => ({
          question_id: q.id,
          question: q.question,
          status: q.status,
          answer: q.reply,
          sources: q.sources.map((s) => ({ title: s.title, url: s.url, last_checked: s.lastChecked })),
          asked_at: q.askedAt.toISOString(),
        });
        if (question_id) return shape(await myQuestion(ctx.user, question_id));
        return { questions: (await myQuestions(ctx.user)).map(shape) };
      }),
  );
}
