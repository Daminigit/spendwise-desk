import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AiUnavailableError,
  ask,
  askJson,
  isAiConfigured,
  isTranscriptionConfigured,
  setClaudeForTests,
  setGroqForTests,
  setTranscribeForTests,
  transcribe,
  type GroqChatParams,
  type GroqChatReply,
} from '../../src/ai/model.js';
import { checkSchema, toGroqSchema } from '../../src/ai/schema.js';

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

describe('groq provider', () => {
  afterEach(() => {
    setGroqForTests(null);
    setTranscribeForTests(null);
  });

  function groqReply(content: string, finish_reason = 'stop'): GroqChatReply {
    return { model: 'openai/gpt-oss-120b', choices: [{ message: { content }, finish_reason }] };
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'amount'],
    properties: {
      intent: { type: 'string', enum: ['log_expense', 'other'] },
      amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    },
  };

  it('sends redacted text with a strict json_schema, nullable fields as type unions, intent on the fast model', async () => {
    const calls: GroqChatParams[] = [];
    setGroqForTests(async (p) => {
      calls.push(p);
      return groqReply('{"intent":"log_expense","amount":450}');
    });
    const r = await askJson<{ intent: string; amount: number }>({
      purpose: 'intent',
      system: 's',
      prompt: 'PAN ABCDE1234F, 450 uber',
      schema,
    });

    expect(r.value).toEqual({ intent: 'log_expense', amount: 450 });
    expect(calls[0].model).toBe('openai/gpt-oss-20b');
    expect(JSON.stringify(calls[0])).not.toContain('ABCDE1234F');
    expect(calls[0].response_format?.json_schema.strict).toBe(true);
    expect(calls[0].response_format?.json_schema.schema).toMatchObject({
      properties: { amount: { type: ['number', 'null'] } },
    });
  });

  it('falls back to the other model when one hits its daily rate limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: GroqChatParams[] = [];
    setGroqForTests(async (p) => {
      calls.push(p);
      if (p.model === 'openai/gpt-oss-20b') throw Object.assign(new Error('Rate limit reached (TPD)'), { status: 429 });
      return groqReply('{"intent":"log_expense","amount":320}');
    });
    const r = await askJson<{ intent: string }>({ purpose: 'intent', system: 's', prompt: 'Ola cab 320', schema });
    expect(r.value?.intent).toBe('log_expense');
    expect(calls.map((c) => c.model)).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
    vi.restoreAllMocks();
  });

  it('uses the larger model for answers', async () => {
    const calls: GroqChatParams[] = [];
    setGroqForTests(async (p) => {
      calls.push(p);
      return groqReply('ok');
    });
    await ask({ purpose: 'policy-answer', system: 's', prompt: 'p' });
    expect(calls[0].model).toBe('openai/gpt-oss-120b');
  });

  it('retries once on a reply that breaks the schema, then gives up without acting on it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    setGroqForTests(async () => {
      n += 1;
      return groqReply('{"intent":"buy_stocks","amount":"lots"}');
    });
    await expect(askJson({ purpose: 'intent', system: 's', prompt: 'p', schema })).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    expect(n).toBe(2);
    vi.restoreAllMocks();
  });

  it('accepts a good reply on the retry', async () => {
    const replies = ['not json', '{"intent":"other","amount":null}'];
    setGroqForTests(async () => groqReply(replies.shift()!));
    const r = await askJson<{ intent: string }>({ purpose: 'intent', system: 's', prompt: 'p', schema });
    expect(r.value).toEqual({ intent: 'other', amount: null });
  });

  it('reports a content-filtered reply as a refusal', async () => {
    setGroqForTests(async () => groqReply('', 'content_filter'));
    const r = await ask({ purpose: 'x', system: 's', prompt: 'p' });
    expect(r.refused).toBe(true);
  });

  it('transcribes through the injected Whisper', async () => {
    setTranscribeForTests(async () => '  add 450 uber  ');
    expect(isTranscriptionConfigured()).toBe(true);
    expect(await transcribe(Buffer.from('x'), 'v.webm')).toBe('add 450 uber');
  });
});

describe('schema checks', () => {
  it('flags missing keys, wrong types, extra keys and bad enum values', () => {
    const s = {
      type: 'object',
      additionalProperties: false,
      required: ['a', 'b'],
      properties: { a: { type: 'string', enum: ['x', 'y'] }, b: { type: 'array', items: { type: 'number' } } },
    };
    expect(checkSchema({ a: 'x', b: [1, 2] }, s)).toBeNull();
    expect(checkSchema({ a: 'x' }, s)).toMatch(/missing/);
    expect(checkSchema({ a: 'z', b: [] }, s)).toMatch(/allowed values/);
    expect(checkSchema({ a: 'x', b: ['1'] }, s)).toMatch(/expected number/);
    expect(checkSchema({ a: 'x', b: [], c: 1 }, s)).toMatch(/not allowed/);
  });

  it('rewrites nullable enums for Groq with null in the enum', () => {
    expect(toGroqSchema({ anyOf: [{ type: 'string', enum: ['cash', 'upi'] }, { type: 'null' }] })).toEqual({
      type: ['string', 'null'],
      enum: ['cash', 'upi', null],
    });
  });
});
