// Real extension/CDP checks with a scripted model, for the company machine. No AI credentials or real sites.
import { launch } from 'puppeteer-core';
import { serve } from '@hono/node-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createApp } from '../server/app';
import type { ModelProvider } from '../server/model';
import { PolicyStore } from '../server/store';
import { DEFAULT_POLICY, type Run } from '../src/shared/contracts';
import type { AgentCall } from '../src/shared/agent';

const executablePath = process.env.CHROME_PATH;
if (!executablePath) throw new Error('Set CHROME_PATH to Chrome for Testing / Chromium.');
const directory = await mkdtemp(join(tmpdir(), 'workbrowser-agent-browser-'));
const store = new PolicyStore(directory);
const token = crypto.randomUUID() + crypto.randomUUID();
let origin = '';
const model: ModelProvider = {
  info: { provider: 'vertex', model: 'scripted-browser-test', configured: true },
  async turn(request) {
    const japanese = request.prompt.includes('要約');
    let call: AgentCall;
    const last = request.history.at(-1)?.results[0];
    if (!request.initial && !last) call = { name: 'navigate', args: { url: origin + '/research' } };
    else if (!last || last.name === 'navigate') call = { name: 'read', args: {} };
    else if (last.name === 'read' && request.currentUrl.endsWith('/research') && !japanese) call = { name: 'click', args: { target: { role: 'link', name: 'Team details' } } };
    else if (last.name === 'click') call = { name: 'read', args: {} };
    else {
      const all = [request.initial?.text ?? '', ...request.history.flatMap(e => e.results.map(r => r.text))].join('\n');
      assert(all.includes('Revenue: 42 million'), 'The model must receive actual page content');
      if (!japanese) assert(all.includes('Employees: 7'), 'The model must receive the linked page content');
      call = { name: 'done', args: { outcome: 'success', answer: japanese ? '売上は42 millionです。' : 'Revenue: 42 million. Employees: 7.' } };
    }
    return { content: { role: 'model', parts: [{ functionCall: call }] } };
  },
};
const app = createApp({ mode: 'local', token, localEmail: 'developer@example.test', localAdmin: true }, store, model);
app.get('/research', c => c.html('<!doctype html><html lang="en"><title>Research</title><h1>Company</h1><p>Revenue: 42 million</p><a href="/team">Team details</a></html>'));
app.get('/team', c => c.html('<!doctype html><html lang="en"><title>Team</title><h1>Team</h1><p>Employees: 7</p></html>'));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => { if (server.listening) resolve(); else server.once('listening', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing server address');
origin = `http://127.0.0.1:${address.port}`;
await store.save({ ...DEFAULT_POLICY, allowedOrigins: [origin], modelOrigins: [origin] });
let browser: Awaited<ReturnType<typeof launch>> | undefined;
try {
  browser = await launch({ executablePath, headless: true, pipe: true, enableExtensions: [resolve('dist')], args: ['--no-sandbox', '--use-mock-keychain'] });
  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const extension = 'chrome-extension://' + new URL(target.url()).host;
  const options = await browser.newPage();
  await options.goto(extension + '/options.html');
  const send = <T>(message: unknown): Promise<T> => options.evaluate(async value => {
    const response = await chrome.runtime.sendMessage(value);
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }, message);
  await send({ type: 'connect', serverUrl: origin, token });
  const page = await browser.newPage();
  await page.goto('about:blank#workbrowser-agent-smoke'); // Navigate out without observing the blank page.
  const tabs = await options.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find(t => t.url === 'about:blank#workbrowser-agent-smoke');
  assert(tab?.id);
  async function waitRun(): Promise<Run> {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const state = await send<{ run?: Run }>({ type: 'state' });
      if (state.run && state.run.status !== 'running') return state.run;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Agent timed out');
  }
  await send({ type: 'start', prompt: `Go to ${origin}/research, follow the team link and report revenue and employees.`, tabId: tab.id });
  let run = await waitRun();
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.outcome, 'success');
  assert(run.output?.includes('Employees: 7'));
  assert(run.sources?.includes(origin + '/team'));
  console.info('PASS: blank tab -> URL -> page content -> linked page -> final answer');
  await page.goto(origin + '/research');
  await send({ type: 'start', prompt: 'このページの売上を日本語で要約して。', tabId: tab.id });
  run = await waitRun();
  assert.equal(run.status, 'completed', run.message);
  assert(run.output?.includes('売上'));
  assert.equal(page.url(), origin + '/research');
  assert(!run.events.some(event => event.label === 'navigate'));
  console.info('PASS: current-page summary without navigation, Japanese answer');
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
