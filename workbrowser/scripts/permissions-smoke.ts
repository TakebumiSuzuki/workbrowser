// Real extension and approval UI with a scripted model; no external AI or real business data.
import { launch } from 'puppeteer-core';
import { serve } from '@hono/node-server';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createApp } from '../server/app';
import { PolicyStore } from '../server/store';
import type { ModelProvider } from '../server/model';
import { DEFAULT_POLICY, type AppState, type Policy } from '../src/shared/contracts';
import type { AgentCall } from '../src/shared/agent';

const executablePath = process.env.CHROME_PATH;
if (!executablePath) throw new Error('Set CHROME_PATH to Chrome / Chromium.');
const directory = await mkdtemp(join(tmpdir(), 'workbrowser-permissions-'));
const store = new PolicyStore(directory);
const token = crypto.randomUUID() + crypto.randomUUID();
const model: ModelProvider = {
  info: { provider: 'vertex', model: 'scripted-permissions', configured: true },
  async turn(request) {
    const last = request.history.at(-1)?.results[0];
    const call: AgentCall = !last
      ? { name: 'click', args: { target: { role: 'button', name: request.prompt.includes('delete') ? '私用メモを削除' : 'Save item' }, intent: request.prompt } }
      : { name: 'done', args: { outcome: last.ok ? 'success' : 'partial', answer: last.ok ? 'Requested action completed.' : `Action was not completed: ${last.text}` } };
    return { content: { role: 'model', parts: [{ functionCall: { ...call, id: crypto.randomUUID() } }] } };
  },
};
const app = createApp({ mode: 'local', token, localEmail: 'developer@example.test', localAdmin: true }, store, model);
app.get('/edit', c => c.html(`<!doctype html><html><title>Approval fixture</title>
<style>body{font-family:sans-serif;padding:40px}button{padding:10px;margin:8px}</style>
<h1>Example item</h1><button type="button" id="save" onclick="document.body.dataset.writes=String(Number(document.body.dataset.writes||0)+1);document.querySelector('#result').textContent='Saved '+document.body.dataset.writes">Save item</button>
<button type="button" id="delete" onclick="document.body.dataset.deletions=String(Number(document.body.dataset.deletions||0)+1);document.querySelector('#result').textContent='Deleted '+document.body.dataset.deletions">私用メモを削除</button>
<p id="result">No actions yet</p></html>`));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => { if (server.listening) resolve(); else server.once('listening', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing server address');
const origin = `http://127.0.0.1:${address.port}`;
await store.save({ ...DEFAULT_POLICY, allowedOrigins: [origin], modelOrigins: [origin] });
let browser: Awaited<ReturnType<typeof launch>> | undefined;
try {
  browser = await launch({ executablePath, headless: true, pipe: true, enableExtensions: [resolve('dist')], args: ['--no-sandbox', '--use-mock-keychain'] });
  const worker = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const extension = 'chrome-extension://' + new URL(worker.url()).host;
  const options = await browser.newPage();
  await options.goto(extension + '/options.html');
  const send = <T>(message: unknown): Promise<T> => options.evaluate(async value => {
    const response = await chrome.runtime.sendMessage(value);
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }, message);
  await send({ type: 'connect', serverUrl: origin, token });
  const page = await browser.newPage();
  await page.goto(origin + '/edit');
  const tabs = await options.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find(tab => tab.url === origin + '/edit');
  assert(tab?.id);
  const panel = await browser.newPage();
  const errors: string[] = [];
  panel.on('pageerror', error => errors.push(String(error)));
  options.on('pageerror', error => errors.push(String(error)));
  await panel.setViewport({ width: 410, height: 700 });
  await panel.goto(extension + '/sidepanel.html');
  await panel.waitForSelector('#prompt');
  const waitState = async (predicate: (state: AppState) => boolean): Promise<AppState> => {
    const deadline = Date.now() + 45000;
    let state: AppState | undefined;
    while (Date.now() < deadline) {
      state = await send<AppState>({ type: 'state' });
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${state?.run?.status}: ${state?.run?.message}`);
  };
  const start = (prompt: string) => send({ type: 'start', prompt, tabId: tab.id });
  const finished = (prompt: string) => waitState(state => state.run?.prompt === prompt && state.run.status !== 'running');
  const pending = async (prompt: string) => {
    const state = await waitState(state => state.run?.prompt === prompt && !!state.pendingApproval);
    await panel.waitForSelector('[data-approval-answer="approve"]');
    return state.pendingApproval!;
  };
  const answer = (value: string) => panel.$eval(`[data-approval-answer="${value}"]`, element => (element as HTMLButtonElement).click());
  const counts = () => page.evaluate(() => ({ writes: Number(document.body.dataset.writes ?? 0), deletions: Number(document.body.dataset.deletions ?? 0) }));
  const setPolicy = async (patch: Partial<Policy>) => {
    const current = await send<Policy>({ type: 'policy' });
    await send({ type: 'save-policy', policy: { ...current, ...patch } });
  };

  await start('save once');
  await pending('save once');
  assert.deepEqual(await counts(), { writes: 0, deletions: 0 });
  for (const width of [320, 410, 600]) {
    await panel.setViewport({ width, height: 480 });
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
  }
  await panel.setViewport({ width: 410, height: 700 });
  await mkdir('artifacts', { recursive: true });
  await panel.screenshot({ path: 'artifacts/approval.png' });
  await panel.reload();
  await panel.waitForSelector('[data-approval-answer="approve"]');
  await answer('approve');
  assert.equal((await finished('save once')).run?.outcome, 'success');
  assert.equal((await counts()).writes, 1);
  assert.deepEqual((await send<Policy>({ type: 'policy' })).writeRules, []);
  console.info('PASS: Ask waits without clicking; UI reload restores request; Approve once executes exactly once');

  await start('delete private note');
  const declined = await pending('delete private note');
  assert.equal(declined.category, 'delete');
  await answer('decline');
  const declinedState = await finished('delete private note');
  assert.equal(declinedState.run?.outcome, 'partial');
  assert(declinedState.run?.events.some(event => event.action?.tool === 'click' && event.label === 'Click failed' && event.status === 'error'));
  assert(!declinedState.run?.events.some(event => event.action?.tool === 'click' && event.label === 'Clicked'));
  assert.equal((await counts()).deletions, 0);
  await assert.rejects(send({ type: 'answer-approval', id: declined.id, runId: declined.runId, answer: 'approve' }));
  console.info('PASS: Japanese private-note deletion uses the same approval rule; decline and stale reply do not act');

  await start('save and remember');
  await pending('save and remember');
  await answer('approve-remember');
  await finished('save and remember');
  assert.equal((await counts()).writes, 2);
  assert.deepEqual((await send<Policy>({ type: 'policy' })).writeRules, [{ origin, rule: 'allow' }]);
  await start('save with site allow');
  assert.equal((await finished('save with site allow')).run?.outcome, 'success');
  assert.equal((await counts()).writes, 3);
  console.info('PASS: Always allow persists an exact-origin rule; the next requested save needs no repeated approval');

  // Change both the default and a site override using the actual Settings UI.
  await options.reload();
  await options.waitForSelector('nav button:nth-child(2)');
  await options.$eval('nav button:nth-child(2)', element => (element as HTMLButtonElement).click());
  await options.waitForSelector('[aria-label="Default approval mode"]');
  await options.select('[aria-label="Default approval mode"]', 'auto');
  await options.select('[aria-label="Action rule 1"]', 'ask');
  await options.$eval('section form', element => (element as HTMLFormElement).requestSubmit());
  await options.waitForFunction(() => document.body.innerText.includes('Saved. Changes apply'), { polling: 100 });
  assert.equal((await send<Policy>({ type: 'policy' })).writeMode, 'auto');
  await start('save with explicit ask');
  const ask = await pending('save with explicit ask');
  assert.equal(ask.canRemember, false);
  assert.equal(await panel.$('[data-approval-answer="approve-remember"]'), null);
  await setPolicy({ writeRules: [{ origin, rule: 'block' }] });
  await answer('approve');
  const revoked = await finished('save with explicit ask');
  assert.equal(revoked.run?.outcome, 'partial');
  assert(revoked.run?.output?.includes('WRITE_BLOCKED'));
  assert.equal((await counts()).writes, 3);
  await start('save blocked');
  const blocked = await finished('save blocked');
  assert.equal(blocked.pendingApproval, null);
  assert.equal(blocked.run?.outcome, 'partial');
  assert.equal((await counts()).writes, 3);
  console.info('PASS: Settings saves mode/rules; explicit Ask overrides Auto; Block and revocation prevent dispatch');

  await setPolicy({ writeMode: 'auto', writeRules: [] });
  await start('save with auto');
  assert.equal((await finished('save with auto')).run?.outcome, 'success');
  assert.equal((await counts()).writes, 4);
  await setPolicy({ writeMode: 'ask' });
  await start('save then stop');
  const stopped = await pending('save then stop');
  await panel.$eval('#approval-title', element => (element.parentElement!.querySelector('button') as HTMLButtonElement).click());
  const afterStop = await finished('save then stop');
  assert.equal(afterStop.run?.status, 'stopped');
  await waitState(state => !state.pendingApproval);
  await assert.rejects(send({ type: 'answer-approval', id: stopped.id, runId: stopped.runId, answer: 'approve' }));
  assert.equal((await counts()).writes, 4);
  console.info('PASS: Auto runs requested actions; Stop withdraws approval and rejects a late answer');

  await start('save changed target');
  await pending('save changed target');
  await page.$eval('#save', element => { element.textContent = 'Save a different item'; });
  await answer('approve');
  assert.equal((await finished('save changed target')).run?.outcome, 'partial');
  assert.equal((await counts()).writes, 4);
  assert.deepEqual(errors, []);
  console.info('PASS: target revalidation prevents a changed button from receiving an earlier approval');
} finally {
  if (browser) await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
