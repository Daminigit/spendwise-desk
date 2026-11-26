import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AiUnavailableError, ask, askJson, isAiConfigured, setClaudeForTests } from '../../src/ai/claude.js';

function reply(text: string, stop_reason: BetaMessage['stop_reason'] = 'end_turn'): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: text ? [{ type: 'text', text, citations: null }] : [],
    stop_reason,
    stop_sequence: null,
  } as unknown as BetaMessage;
}

function fake(response: BetaMessage | Error) {
  const calls: BetaMessageCreateParamsNonStreaming[] = [];
  setClaudeForTests(async (params) => {
    calls.push(params);
    if (response instanceof Error) throw response;
    return response;
  });
  return calls;
}

afterEach(() => setClaudeForTests(null));

describe('ask', () => {
  it('is not configured in tests unless a fake is injected', () => {
    expect(isAiConfigured()).toBe(false);
    fake(reply('hi'));
    expect(isAiConfigured()).toBe(true);
  });

  it('refuses to call the real API without a key', async () => {
    await expect(ask({ purpose: 't', system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('redacts PII before it reaches the model and reports what was removed', async () => {
    const calls = fake(reply('Noted.'));
    const res = await ask({
      purpose: 't',
      system: 'sys',
      prompt: 'My PAN is ABCDE1234F, call 9876543210',
    });

    const sent = JSON.stringify(calls[0]);
    expect(sent).not.toContain('ABCDE1234F');
    expect(sent).not.toContain('9876543210');
    expect(calls[0].messages[0].content).toBe('My PAN is [PAN], call [PHONE]');
    expect(res.redacted).toEqual(['PAN', 'PHONE']);
  });

  it('redacts PII the model echoes back', async () => {
    fake(reply('Your PAN ABCDE1234F is on file.'));
    const res = await ask({ purpose: 't', system: 's', prompt: 'hi' });
    expect(res.text).toBe('Your PAN [PAN] is on file.');
  });

  it('sends the configured model, effort, schema and refusal fallback', async () => {
    const calls = fake(reply('{"a":1}'));
    const schema = {
      type: 'object',
      properties: { a: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    };
    const res = await askJson<{ a: number }>({
      purpose: 't',
      system: 's',
      prompt: 'p',
      effort: 'low',
      schema,
    });

    expect(res.value).toEqual({ a: 1 });
    expect(calls[0].model).toBe('claude-opus-5-5');
    expect(calls[0].output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema },
    });
    expect(calls[0].fallbacks).toBe('default');
  });

  it('returns refusals as data, not errors', async () => {
    fake(reply('', 'refusal'));
    const res = await ask({ purpose: 't', system: 's', prompt: 'p' });
    expect(res).toMatchObject({ refused: true, text: '' });
  });

  it('wraps API errors and logs them without PII', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake(new Error('upstream failed for prompt containing ABCDE1234F'));

    await expect(ask({ purpose: 't', system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiUnavailableError);
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('[ai:t]');
    expect(logged).not.toContain('ABCDE1234F');
    spy.mockRestore();
  });

  it('treats a reply cut off at max_tokens as unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake(reply('partial', 'max_tokens'));
    await expect(ask({ purpose: 't', system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiUnavailableError);
    vi.restoreAllMocks();
  });
});
