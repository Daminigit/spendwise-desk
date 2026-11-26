import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isAdviceRequest, ADVICE_REFUSAL } from '../../assistant/guard.js';
import { recordEvent } from '../../assistant/events.js';
import { redactText } from '../../ai/redact.js';
import { submitQuestion } from '../../desk/desk.js';
import { run, type McpContext } from '../util.js';

export function registerAskPolicy(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'ask_policy',
    {
      title: 'Ask a policy question (cited, reviewed by finance)',
      description:
        "Ask a question about the organisation's expense policy or GST tax-invoice rules. Answers come from " +
        "Spendwise's source corpus only. If finance has approved an answer on this topic it is returned at once " +
        '(status "answered", with source links and last-checked dates). Otherwise a draft goes to the finance ' +
        'desk for review (status "in_review", with a question_id): tell the user it is with finance and use ' +
        'get_policy_answer later. covered=false means the sources do not cover it; relay what was searched and ' +
        'never fill the gap from your own knowledge. Investment, tax-planning and returns questions are refused.',
      inputSchema: { question: z.string().min(3).max(500).describe('The question, in the user’s words.') },
      annotations: { readOnlyHint: false, openWorldHint: false },
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
          return { status: 'refused', covered: false, refused: true, answer: ADVICE_REFUSAL, sources: [], searched: [] };
        }
        const out = await submitQuestion(ctx.user, { question: q, raw: question, channel: 'text', via: 'mcp' });
        if (out.kind === 'refused') {
          await recordEvent({ ...base, outcome: 'refused', meta: { via: 'mcp' } });
          return { status: 'refused', covered: false, refused: true, answer: out.reply, sources: [], searched: [] };
        }
        const a = out.answer;
        await recordEvent({
          ...base,
          outcome: out.kind === 'canonical' ? 'answered' : a.covered ? 'queued' : 'not_covered',
          meta: {
            via: 'mcp',
            topic: a.topic,
            covered: a.covered,
            canonicalId: a.canonical?.id ?? null,
            sources: a.sources.map((s) => s.url),
            draftId: out.kind === 'queued' ? out.draftId : null,
          },
        });
        if (out.kind === 'canonical') {
          return {
            status: 'answered',
            covered: true,
            answer: out.reply,
            canonical: a.canonical,
            sources: a.sources.map((s) => ({ title: s.title, url: s.url, last_checked: s.lastChecked })),
            searched: a.searched,
          };
        }
        return {
          status: a.covered ? 'in_review' : 'not_covered',
          covered: a.covered,
          question_id: out.draftId,
          answer: out.reply,
          sources: [],
          searched: a.searched,
        };
      }),
  );
}
