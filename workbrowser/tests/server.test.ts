import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { PolicyStore } from '../server/store';
import { DEFAULT_POLICY } from '../src/shared/contracts';
import { authenticate, type AuthConfig } from '../server/auth';
import type { ModelProvider } from '../server/model';
import type { AgentRequest } from '../src/shared/agent';

let directory: string;
const token = 'local-test-token-01234567890123456789';
const config: AuthConfig = { mode: 'local', token, localEmail: 'developer@example.test', localAdmin: true };
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'workbrowser-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function setup(admin = true) { return createApp({ ...config, localAdmin: admin }, new PolicyStore(directory)); }

describe('API access and policy persistence', () => {
  it('requires a token even for local API requests', async () => {
    expect((await setup().request('/api/policy')).status).toBe(401);
    expect((await setup().request('/api/policy', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await setup().request('/api/policy', { headers })).status).toBe(200);
  });
  it('rejects web page origins and allows extension preflight', async () => {
    expect((await setup().request('/api/policy', { headers: { ...headers, origin: 'https://evil.test' } })).status).toBe(403);
    const response = await setup().request('/api/policy', { method: 'OPTIONS', headers: { origin: 'chrome-extension://' + 'a'.repeat(32), 'access-control-request-method': 'PUT' } });
    expect(response.status).toBe(204);
  });
  it('enforces admin permission on the server', async () => {
    const app = setup(false);
    expect((await app.request('/api/policy', { headers })).status).toBe(200);
    expect((await app.request('/api/policy', { method: 'PUT', headers, body: JSON.stringify(DEFAULT_POLICY) })).status).toBe(403);
  });
  it('persists policy and detects concurrent changes', async () => {
    const app = setup();
    const response = await app.request('/api/policy', { method: 'PUT', headers, body: JSON.stringify({ ...DEFAULT_POLICY, allowedOrigins: [] }) });
    expect(response.status).toBe(200);
    expect((await response.json()).revision).toBe(1);
    expect((await new PolicyStore(directory).read()).allowedOrigins).toEqual([]);
    expect((await app.request('/api/policy', { method: 'PUT', headers, body: JSON.stringify(DEFAULT_POLICY) })).status).toBe(409);
  });
  it('serializes concurrent saves without losing changes', async () => {
    const store = new PolicyStore(directory);
    const result = await Promise.allSettled([store.save(DEFAULT_POLICY), store.save(DEFAULT_POLICY)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.read()).revision).toBe(1);
  });
  it('denies forbidden targets and excessive overrides', async () => {
    const app = setup();
    expect((await app.request('/api/agent/plan', { method: 'POST', headers, body: JSON.stringify({ prompt: '取得', url: 'https://evil.test' }) })).status).toBe(403);
    expect((await app.request('/api/policy', { method: 'PUT', headers, body: JSON.stringify({ ...DEFAULT_POLICY, overrides: [{ user: 'u@example.test', expiresAt: new Date(Date.now() + 48 * 3600000).toISOString() }] }) })).status).toBe(400);
  });
  it('produces a mock plan without receiving page content', async () => {
    const app = setup();
    const request = { prompt: 'ページのテキストを取得', url: 'http://localhost:8787/demo' };
    const response = await app.request('/api/agent/plan', { method: 'POST', headers, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect((await response.json()).mode).toBe('mock');
    expect((await app.request('/api/agent/plan', { method: 'POST', headers, body: JSON.stringify({ ...request, pageContent: 'secret' }) })).status).toBe(400);
  });
  it('enforces step budgets before starting', async () => {
    const app = setup();
    await app.request('/api/policy', { method: 'PUT', headers, body: JSON.stringify({ ...DEFAULT_POLICY, maxSteps: 10 }) });
    expect((await app.request('/api/agent/plan', { method: 'POST', headers, body: JSON.stringify({ prompt: '100件を順番に処理', url: 'http://localhost:8787/demo' }) })).status).toBe(400);
  });
  it('does not trust forged IAP identity headers', async () => {
    expect(await authenticate(new Headers({ 'x-goog-authenticated-user-email': 'accounts.google.com:admin@example.com', 'x-goog-iap-jwt-assertion': 'forged' }), { ...config, mode: 'iap', iapAudience: '/projects/123/global/backendServices/123', workspaceDomain: 'example.com' })).toBeNull();
  });
});

describe('agent API and model data boundary', () => {
  const request: AgentRequest = { prompt: 'Summarize this page.', currentUrl: 'http://localhost:8787/demo', initial: { url: 'http://localhost:8787/demo', text: 'Page content' }, notes: '', history: [], sources: ['http://localhost:8787/demo'], finishOnly: false };
  function agentSetup() {
    const received: AgentRequest[] = [];
    const model: ModelProvider = { info: { configured: true, provider: 'vertex', model: 'test' }, async turn(value) {
      received.push(value);
      return { content: { role: 'model', parts: [{ functionCall: { name: 'done', args: { outcome: 'success', answer: 'Summary.' } } }] } };
    } };
    const store = new PolicyStore(directory);
    return { app: createApp(config, store, model), received, store };
  }
  it('requires authentication and explicit AI site approval before sending page contents', async () => {
    const { app, received, store } = agentSetup();
    expect((await app.request('/api/agent/turn', { method: 'POST', body: JSON.stringify(request) })).status).toBe(401);
    expect((await app.request('/api/agent/turn', { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(403);
    expect(received).toHaveLength(0);
    await store.save({ ...DEFAULT_POLICY, modelOrigins: ['http://localhost:8787'] });
    expect((await app.request('/api/agent/turn', { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(200);
    expect(received[0].initial?.text).toBe('Page content');
  });
  it('rejects previously captured source data when an administrator revokes approval', async () => {
    const { app, received, store } = agentSetup();
    const saved = await store.save({ ...DEFAULT_POLICY, modelOrigins: ['http://localhost:8787'] });
    await store.save({ ...saved, modelOrigins: [] });
    const historyOnly = { ...request, initial: undefined, sources: [], history: [{ model: { role: 'model', parts: [{ functionCall: { name: 'read', args: {} } }] }, results: [{ name: 'read', ok: true, url: request.currentUrl, text: 'Earlier private text' }] }] };
    expect((await app.request('/api/agent/turn', { method: 'POST', headers, body: JSON.stringify(historyOnly) })).status).toBe(403);
    expect(received).toHaveLength(0);
  });
  it('does not extend AI approval through a per-user browsing override', async () => {
    const { app, received, store } = agentSetup();
    await store.save({ ...DEFAULT_POLICY, overrides: [{ user: config.localEmail, expiresAt: new Date(Date.now() + 60000).toISOString() }] });
    expect((await app.request('/api/agent/turn', { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(403);
    expect(received).toHaveLength(0);
  });
  it('rejects images, extra fields and excessive histories before calling a model', async () => {
    const { app, received } = agentSetup();
    for (const body of [
      { ...request, screenshot: 'base64' },
      { ...request, history: [{ model: { role: 'model', parts: [{ inlineData: { data: 'image' } }] }, results: [] }] },
      { ...request, prompt: 'x'.repeat(8001) },
    ]) expect((await app.request('/api/agent/turn', { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
    expect(received).toHaveLength(0);
  });
  it('tests native function calling without any page content', async () => {
    const { app, received } = agentSetup();
    const response = await app.request('/api/agent/test', { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(received[0]).toMatchObject({ sources: [], history: [], finishOnly: true });
    expect(received[0].initial).toBeUndefined();
  });
});
