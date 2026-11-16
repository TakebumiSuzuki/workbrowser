import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgent } from '../src/agent/loop';
import { createApp } from '../server/app';
import { createModel } from '../server/model';
import { PolicyStore } from '../server/store';
import { DEFAULT_POLICY } from '../src/shared/contracts';
import type { AgentTurn } from '../src/shared/agent';
import type { Result } from '../src/browser-control';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'workbrowser-agent-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it.each(['en', 'ja'])('runs the actual loop through API validation and Gemini HTTP encoding across pages (%s)', async language => {
  const store = new PolicyStore(directory);
  await store.save({ ...DEFAULT_POLICY, allowedOrigins: ['https://research.test'], modelOrigins: ['https://research.test'] });
  const httpBodies: Record<string, unknown>[] = [];
  let turn = 0;
  const answer = language === 'ja' ? '売上は42、従業員数は7です。' : 'Revenue is 42 and there are 7 employees.';
  const actions = [
    { name: 'navigate', args: { url: 'https://research.test/' } },
    { name: 'read', args: {} },
    { name: 'remember', args: { notes: 'Revenue=42; source https://research.test/' } },
    { name: 'click', args: { target: { role: 'link', name: 'Team' } } },
    { name: 'read', args: {} },
    { name: 'done', args: { outcome: 'success', answer } },
  ];
  const provider = createModel({ AI_PROVIDER: 'gemini', AI_MODEL: 'test-model', GEMINI_API_KEY: 'local-test-only' }, async (_url, init) => {
    httpBodies.push(JSON.parse(init!.body as string));
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { ...actions[turn], id: `c${turn++}` }, thoughtSignature: 'preserved' }] } }] });
  });
  const token = 'test-token-for-full-agent-integration';
  const app = createApp({ mode: 'local', token, localEmail: 'test@example.test', localAdmin: true }, store, provider);
  let url = 'chrome://newtab/';
  const browser = vi.fn(async (name: string, args: Record<string, unknown>): Promise<Result> => {
    if (name === 'navigate') url = args.url as string;
    if (name === 'click') url = 'https://research.test/team';
    const content = url.endsWith('/team') ? 'Employees: 7' : 'Revenue: 42; link Team [e1]';
    return { ok: true, text: content, data: { content } };
  });
  const result = await runAgent(language === 'ja' ? 'https://research.test/ を開き、関連ページも調べて売上と従業員数を教えて。' : 'Visit https://research.test/ and find revenue and team size from the linked pages.', {
    signal: new AbortController().signal,
    checkpoint: async () => ({ url, maxSteps: 20, canObserve: url.startsWith('https:') }),
    model: async request => {
      const response = await app.request('/api/agent/turn', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
      expect(response.status).toBe(200);
      return response.json() as Promise<AgentTurn>;
    },
    call: browser, progress: async () => undefined,
  });
  expect(result.answer).toBe(answer);
  expect(result.sources).toEqual(['https://research.test/', 'https://research.test/team']);
  expect(browser.mock.calls.map(c => c[0])).toEqual(['navigate', 'read', 'click', 'read']);
  const finalWire = JSON.stringify(httpBodies.at(-1));
  expect(finalWire).toContain('Revenue: 42'); expect(finalWire).toContain('Employees: 7');
  expect(finalWire).toContain('preserved'); expect(finalWire).not.toContain('local-test-only');
});
