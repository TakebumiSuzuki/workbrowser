// Verify the activity shown in the actual extension UI; uses local fixtures and a scripted model.
import { launch } from 'puppeteer-core';
import { serve } from '@hono/node-server';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createApp } from '../server/app';
import type { ModelProvider } from '../server/model';
import { PolicyStore } from '../server/store';
import { DEFAULT_POLICY, type Run } from '../src/shared/contracts';
import type { AgentCall } from '../src/shared/agent';

const executablePath = process.env.CHROME_PATH;
if (!executablePath) throw new Error('Set CHROME_PATH to Chrome / Chromium.');
const directory = await mkdtemp(join(tmpdir(), 'workbrowser-activity-'));
const store = new PolicyStore(directory);
const token = crypto.randomUUID() + crypto.randomUUID();
let origin = '', index = 0;
const model: ModelProvider = {
  info: { provider: 'vertex', model: 'scripted-activity', configured: true },
  async turn() {
    const actions: AgentCall[] = [
      { name: 'navigate', args: { url: origin + '/start?from=activity' } },
      { name: 'click', args: { target: { role: 'link', name: 'Open search form' } } },
      { name: 'set', args: { target: { role: 'textbox', name: 'Search text' }, value: 'Tokyo' } },
      { name: 'set', args: { target: { role: 'combobox', name: 'Region' }, value: 'west' } },
      { name: 'click', args: { target: { role: 'button', name: 'Missing button' } } },
      { name: 'done', args: { outcome: 'partial', answer: 'Opened the form, entered Tokyo and selected West. The missing button was not clicked.' } },
    ];
    return { content: { role: 'model', parts: [{ functionCall: { ...actions[index++], id: crypto.randomUUID() } }] } };
  },
};
const app = createApp({ mode: 'local', token, localEmail: 'developer@example.test', localAdmin: true }, store, model);
app.get('/start', c => c.html('<!doctype html><title>Activity start</title><a href="/form">Open search form</a>'));
app.get('/form', c => c.html('<!doctype html><title>Search form</title><h1>Search</h1><label>Search text<input></label><label>Region<select><option value="east">East</option><option value="west">West</option></select></label>'));
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
    const result = await chrome.runtime.sendMessage(value);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, message);
  await send({ type: 'connect', serverUrl: origin, token });
  const page = await browser.newPage();
  await page.goto('about:blank#activity-fixture');
  const tabs = await options.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find(tab => tab.url === 'about:blank#activity-fixture');
  assert(tab?.id);
  await send({ type: 'start', prompt: 'Open the search form, enter Tokyo, select West, and try the missing button.', tabId: tab.id });
  let run: Run | undefined;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    run = (await send<{ run?: Run }>({ type: 'state' })).run;
    if (run && run.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(run, 'The task should have a recorded result');
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.outcome, 'partial');
  assert(run.events.some(event => event.action?.tool === 'navigate' && event.action.url === origin + '/start?from=activity'), 'Activity must contain the actual opened URL');
  assert(run.events.some(event => event.action?.tool === 'click' && event.action.target?.includes('Open search form') && event.status === 'ok'), 'Activity must contain the resolved clicked link');
  assert(run.events.some(event => event.action?.tool === 'set' && event.action.detail?.includes('Tokyo')));
  assert(run.events.some(event => event.label === 'Selected option' && event.action?.detail?.includes('West')));
  assert(run.events.some(event => event.label === 'Click failed' && event.action?.detail?.includes('NO_MATCH')));
  assert(!run.events.some(event => event.label.includes('Choosing the next step')));
  assert.equal(await page.$eval('input', element => (element as HTMLInputElement).value), 'Tokyo');
  assert.equal(await page.$eval('select', element => (element as HTMLSelectElement).value), 'west');
  const panel = await browser.newPage();
  const errors: string[] = [];
  panel.on('pageerror', error => errors.push(String(error)));
  await panel.setViewport({ width: 410, height: 800 });
  await panel.goto(extension + '/sidepanel.html');
  await panel.waitForSelector('[data-activity]');
  const checkVisible = async () => {
    await panel.$eval('[data-activity]', element => { (element as HTMLDetailsElement).open = true; element.scrollIntoView(); });
    const activity = await panel.$eval('[data-activity] > ol', element => (element as HTMLElement).innerText);
    for (const value of ['Opened page', origin + '/start?from=activity', 'Open search form', 'Entered text', 'Search text', 'Tokyo', 'Region', 'West', 'Click failed', 'NO_MATCH']) assert(activity.includes(value), `Expanded activity must show ${value}`);
    assert(!activity.includes('Choosing the next step'));
    assert(await panel.$eval('[data-activity] > details', element => !(element as HTMLDetailsElement).open), 'Raw log stays collapsed');
    assert.equal(await panel.$eval('[data-activity] a', element => (element as HTMLAnchorElement).href), origin + '/start?from=activity');
  };
  await checkVisible();
  await panel.reload();
  await panel.waitForSelector('[data-activity]');
  await checkVisible();
  await mkdir('artifacts', { recursive: true });
  await panel.screenshot({ path: 'artifacts/activity.png' });
  for (const width of [320, 600]) {
    await panel.setViewport({ width, height: 480 });
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
  }
  const legacy: Run = { ...run, id: crypto.randomUUID(), prompt: 'Legacy activity fixture', trace: undefined, events: [{ at: new Date().toISOString(), label: 'Choosing the next step…', status: 'info' }, { at: new Date().toISOString(), label: 'click', status: 'ok' }] };
  await options.evaluate(value => chrome.storage.local.set({ run: value, history: [value], conversationId: value.conversationId ?? value.id }), legacy);
  await panel.waitForFunction(() => document.querySelector('main')?.textContent?.includes('Legacy activity fixture'), { polling: 100 });
  await panel.$eval('[data-activity]', element => { (element as HTMLDetailsElement).open = true; });
  assert((await panel.$eval('[data-activity]', element => (element as HTMLElement).innerText)).includes('Detailed activity entries were not saved'));
  assert.deepEqual(errors, []);
  console.info('PASS: real actions and errors appear in expanded Activity, links work, and details persist after reload');
  console.info('PASS: older progress-only history explicitly reports that detailed activity was not saved');
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
