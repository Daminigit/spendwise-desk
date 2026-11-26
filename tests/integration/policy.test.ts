/**
 * Cited policy answers, with a fake Claude. Checks grounding (every shown
 * answer cites a retrieved passage), "not covered" behaviour, sentence cap,
 * and the scope check on model output. Also the ask_policy MCP tool.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { setClaudeForTests } from '../../src/ai/claude.js';
import { answerPolicyQuestion } from '../../src/assistant/policy.js';
import {
  createTestOrg,
  hasTestDb,
  loginAs,
  mcpClientFor,
  startServer,
  type TestOrg,
  type TestServer,
} from '../helpers/fixtures.js';

function fakeAnswer(
  answer: { covered: boolean; answer: string; passage_ids: string[] } | ((prompt: string) => object),
) {
  const sent: MessageCreateParamsNonStreaming[] = [];
  setClaudeForTests(async (params) => {
    sent.push(params);
    const prompt = String(params.messages[0].content);
    const body = typeof answer === 'function' ? answer(prompt) : answer;
    return {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: JSON.stringify(body), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    } as never;
  });
  return sent;
}

describe.skipIf(!hasTestDb)('policy answers', () => {
  let org: TestOrg;
  let server: TestServer;

  beforeAll(async () => {
    org = await createTestOrg('policy');
    server = await startServer();
  });
  afterAll(async () => server?.close());
  afterEach(() => setClaudeForTests(null));

  it('answers from retrieved passages with a source link and last-checked date', async () => {
    const sent = fakeAnswer((prompt) => ({
      covered: prompt.includes('[policy-limit-lodge]'),
      answer: 'Lodging has a per-item limit of ₹6,000.00 and no daily limit.',
      passage_ids: ['policy-limit-lodge'],
    }));
    const a = await answerPolicyQuestion(org.emp, "What's the hotel limit?");
    expect(a.covered).toBe(true);
    expect(a.reply).toMatch(/₹6,000\.00/);
    expect(a.sources[0]).toMatchObject({
      passageId: 'policy-limit-lodge',
      url: expect.stringMatching(/\/settings\/policy$/),
    });
    expect(a.sources[0].lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(sent[0].messages[0].content)).toContain('Question: What');
  });

  it('cites the CBIC page for tax-invoice questions', async () => {
    fakeAnswer({
      covered: true,
      answer: 'The invoice must show the supplier name, address and GSTIN.',
      passage_ids: ['cbic-invoice-supplier'],
    });
    const a = await answerPolicyQuestion(org.emp, 'What must a GST tax invoice show about the supplier?');
    expect(a.sources[0].url).toBe('https://cbic-gst.gov.in/gst-invoice-rules.html');
  });

  it('says "not covered" and names what it searched, without calling the model, when nothing matches', async () => {
    const sent = fakeAnswer({ covered: true, answer: 'x', passage_ids: [] });
    const a = await answerPolicyQuestion(org.emp, 'Can I expense a gym membership?');
    expect(a.covered).toBe(false);
    expect(a.reply).toMatch(/couldn't find this/);
    expect(a.reply).toMatch(/expense policy/);
    expect(a.searched.join(' ')).toMatch(/CGST Invoice Rules/);
    expect(sent).toHaveLength(0);
  });

  it('treats an answer citing a passage that was not retrieved as not covered', async () => {
    fakeAnswer({ covered: true, answer: 'Meals are free.', passage_ids: ['made-up-id'] });
    const a = await answerPolicyQuestion(org.emp, 'What is the meals limit?');
    expect(a.covered).toBe(false);
    expect(a.sources).toEqual([]);
  });

  it('respects the model saying the passages do not answer it', async () => {
    fakeAnswer({ covered: false, answer: '', passage_ids: [] });
    const a = await answerPolicyQuestion(org.emp, 'Is GST on hotel food claimable as input credit?');
    expect(a.covered).toBe(false);
  });

  it('caps answers at three sentences', async () => {
    fakeAnswer({ covered: true, answer: 'One. Two. Three. Four. Five.', passage_ids: ['policy-receipts'] });
    const a = await answerPolicyQuestion(org.emp, 'When do I need a receipt?');
    expect(a.reply).toBe('One. Two. Three.');
  });

  it('blocks a model answer containing return figures or advice', async () => {
    fakeAnswer({ covered: true, answer: 'Meals give 12% returns annually.', passage_ids: ['policy-limit-meals'] });
    const a = await answerPolicyQuestion(org.emp, 'What is the meals limit?');
    expect(a.covered).toBe(false);
  });

  it('serves the sources page with every source and its last-checked date', async () => {
    const s = await loginAs(server, org.emp);
    const html = await (await s.fetch('/sources')).text();
    expect(html).toContain('https://cbic-gst.gov.in/gst-invoice-rules.html');
    expect(html).toMatch(/expense policy/);
    expect(html).toMatch(/last checked 2026-11-26/);
  });

  it('exposes cited answers over MCP and refuses advice there too', async () => {
    fakeAnswer({ covered: true, answer: 'Receipts are needed above ₹500.00.', passage_ids: ['policy-receipts'] });
    const mcp = await mcpClientFor(server, org.emp);
    const ok = await mcp.call('ask_policy', { question: 'When is a receipt required?' });
    expect(ok.data).toMatchObject({ covered: true, sources: [{ last_checked: expect.any(String) }] });

    const advice = await mcp.call('ask_policy', { question: 'Which mutual fund should I buy with my reimbursement?' });
    expect(advice.data).toMatchObject({ covered: false, refused: true });
    await mcp.close();
  });
});
