import { describe, expect, it, vi } from 'vitest';
import { createModel } from '../server/model';
import { SYSTEM_PROMPT } from '../src/agent/prompt';
import type { AgentRequest } from '../src/shared/agent';

const request: AgentRequest = {
  prompt: 'このページを要約して。', currentUrl: 'https://example.test/', notes: '', sources: ['https://example.test/'], finishOnly: false,
  initial: { url: 'https://example.test/', text: '<<<page-content nonce>>>Sales 42<<<end-page-content nonce>>>' },
  history: [{ model: { role: 'model', parts: [{ functionCall: { name: 'read', args: {}, id: 'call-1' }, thoughtSignature: 'opaque-provider-state' }] },
    results: [{ name: 'read', id: 'call-1', ok: true, text: 'Sales: 42', url: 'https://example.test/' }] }],
};
const success = { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'done', args: { outcome: 'success', answer: '売上は42です。' } }, thoughtSignature: 'next-state' }] } }] };

describe('Gemini model wire protocol', () => {
  it('sends the complete tool/result history with function IDs and thought signatures', async () => {
    const fetcher = vi.fn(async () => Response.json(success));
    const model = createModel({ AI_PROVIDER: 'gemini', AI_MODEL: 'test-model', GEMINI_API_KEY: 'server-only-key' }, fetcher);
    const result = await model.turn(request, new AbortController().signal);
    expect(result.content.parts[0].thoughtSignature).toBe('next-state');
    const [endpoint, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[0].text).toBe(request.prompt);
    expect(body.contents[1]).toEqual(request.history[0].model);
    expect(body.contents[2].parts[0].functionResponse).toMatchObject({ name: 'read', id: 'call-1', response: { text: 'Sales: 42' } });
    expect(body.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT);
    expect(body.tools[0].functionDeclarations.map((t: { name: string }) => t.name)).toContain('navigate');
    expect(JSON.stringify(body)).not.toContain('server-only-key');
    expect(JSON.stringify(model.info)).not.toContain('server-only-key');
  });
  it('limits salvage requests to the final answer tool', async () => {
    const fetcher = vi.fn(async () => Response.json(success));
    await createModel({ AI_PROVIDER: 'gemini', AI_MODEL: 'test-model', GEMINI_API_KEY: 'key' }, fetcher).turn({ ...request, finishOnly: true }, new AbortController().signal);
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).tools[0].functionDeclarations.map((t: { name: string }) => t.name)).toEqual(['done']);
  });
  it('never claims to run a model when credentials are missing', async () => {
    const fetcher = vi.fn();
    const model = createModel({}, fetcher);
    expect(model.info.configured).toBe(false);
    await expect(model.turn(request, new AbortController().signal)).rejects.toThrow('not configured');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not expose provider error bodies that may echo private data', async () => {
    const model = createModel({ AI_PROVIDER: 'gemini', AI_MODEL: 'test-model', GEMINI_API_KEY: 'key' }, async () => Response.json({ error: 'PRIVATE_PAGE_TEXT' }, { status: 403 }));
    await expect(model.turn(request, new AbortController().signal)).rejects.toThrow('HTTP 403');
    await expect(model.turn(request, new AbortController().signal)).rejects.not.toThrow('PRIVATE_PAGE_TEXT');
  });
  it('rejects truncated, text-only and image responses without executing anything', async () => {
    for (const body of [
      { ...success, candidates: [{ ...success.candidates[0], finishReason: 'MAX_TOKENS' }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'I will browse now.' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ inlineData: { data: 'base64' } }] } }] },
    ]) {
      const model = createModel({ AI_PROVIDER: 'gemini', AI_MODEL: 'test-model', GEMINI_API_KEY: 'key' }, async () => Response.json(body));
      await expect(model.turn(request, new AbortController().signal)).rejects.toThrow();
    }
  });
  it('uses the configured Vertex region and service-account metadata without shipping credentials to the client', async () => {
    const calls: { endpoint: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (endpoint: string | URL | Request, init?: RequestInit) => {
      calls.push({ endpoint: String(endpoint), init });
      return String(endpoint).includes('metadata.google.internal') ? Response.json({ access_token: 'short-lived-token', expires_in: 3600 }) : Response.json(success);
    });
    const model = createModel({ AI_PROVIDER: 'vertex', AI_MODEL: 'configured-model', GOOGLE_CLOUD_PROJECT: 'company-project', GOOGLE_CLOUD_LOCATION: 'us-central1', VERTEX_AUTH: 'metadata' }, fetcher);
    await model.turn(request, new AbortController().signal);
    await model.turn(request, new AbortController().signal);
    expect(calls[0].endpoint).toContain('metadata.google.internal');
    expect(calls[1].endpoint).toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/company-project/locations/us-central1/publishers/google/models/configured-model:generateContent');
    expect(calls[1].init?.headers).toMatchObject({ Authorization: 'Bearer short-lived-token' });
    expect(calls.filter(c => c.endpoint.includes('metadata.google.internal'))).toHaveLength(1);
    expect(JSON.stringify(model.info)).not.toContain('short-lived-token');
  });
});
