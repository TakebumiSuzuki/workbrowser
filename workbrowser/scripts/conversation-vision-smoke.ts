// Real Chrome/extension verification with a scripted model; no external AI calls or credentials.
import { launch } from 'puppeteer-core';
import { serve } from '@hono/node-server';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createApp } from '../server/app';
import { PolicyStore } from '../server/store';
import type { ModelProvider } from '../server/model';
import { DEFAULT_POLICY, type AppState } from '../src/shared/contracts';
import type { AgentCall, AgentImage } from '../src/shared/agent';

const executablePath = process.env.CHROME_PATH;
if (!executablePath) throw new Error('Set CHROME_PATH to Chrome / Chromium.');
const directory = await mkdtemp(join(tmpdir(), 'workbrowser-conversation-vision-'));
const store = new PolicyStore(directory);
const token = crypto.randomUUID() + crypto.randomUUID();
let captured: AgentImage | undefined;
let reflected = false, fresh = false;
const model: ModelProvider = {
  info: { provider: 'vertex', model: 'scripted-conversation-vision', configured: true },
  async turn(request) {
    let call: AgentCall;
    if (request.prompt.includes('間違い')) {
      assert.equal(request.conversation?.length, 1);
      assert(request.conversation[0].prompt.includes('検索アイコン'));
      assert(request.conversation[0].answer.includes('検索結果を開きました'));
      assert(request.conversation[0].activity.includes('NO_MATCH'));
      assert(request.conversation[0].activity.includes('screenshot'));
      reflected = true;
      call = { name: 'done', args: { outcome: 'success', answer: '前回の間違いは、名前のない検索アイコンを名前で探したことです。画像の枠と番号で選び直して成功しました。' } };
    } else if (request.prompt.includes('新しい会話')) {
      assert(!request.conversation?.length);
      fresh = true;
      call = { name: 'done', args: { outcome: 'success', answer: '新しい会話です。' } };
    } else if (!request.history.length) {
      call = { name: 'click', args: { target: { role: 'button', name: 'Search' } } };
    } else if (request.history.at(-1)?.results[0].image) {
      captured = request.history.at(-1)!.results[0].image;
      assert(captured && captured.width <= 1600 && captured.height <= 1600);
      assert.equal(Buffer.from(captured.base64, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
      const ref = request.initial?.text.match(/\[([^\]]+)\] button/)?.[1];
      assert(ref, 'The DOM snapshot must identify the unnamed button by ref');
      call = { name: 'click', args: { target: { ref } } };
    } else {
      call = { name: 'done', args: { outcome: 'success', answer: '画像の枠と番号を使って検索結果を開きました。' } };
    }
    return { content: { role: 'model', parts: [{ functionCall: { ...call, id: crypto.randomUUID() } }] } };
  },
};
const app = createApp({ mode: 'local', token, localEmail: 'developer@example.test', localAdmin: true }, store, model);
app.get('/visual', c => c.html(`<!doctype html><html lang="ja"><title>Visual fallback fixture</title>
<style>body{font-family:sans-serif;padding:40px}button{width:72px;height:52px;border:2px solid #555;border-radius:8px;background:white}#secret{position:absolute;left:40px;top:220px;width:240px;height:40px}</style>
<h1>検索</h1><button onclick="document.querySelector('#result').hidden=false"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="black" stroke-width="3" fill="none"/><path d="M15 15L24 24" stroke="black" stroke-width="3"/></svg></button>
<p id="result" hidden>検索結果を開きました</p><input id="secret" type="password" value="PRIVATE_TEST_VALUE" aria-label="Password"></html>`));
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
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(origin + '/visual');
  const panel = await browser.newPage();
  const errors: string[] = [];
  panel.on('pageerror', error => errors.push(String(error)));
  await panel.setViewport({ width: 410, height: 700 });
  await panel.goto(extension + '/sidepanel.html');
  await panel.waitForSelector('#prompt');
  await page.bringToFront();
  await panel.waitForFunction(() => document.querySelector('footer p')?.textContent?.includes('Visual fallback fixture'), { polling: 100 });
  const submit = async (prompt: string) => {
    await panel.$eval('#prompt', (el, value) => { (el as HTMLTextAreaElement).value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, prompt);
    // Vue updates its submit-button state in the next microtask.
    await panel.waitForFunction(() => !(document.querySelector('footer button') as HTMLButtonElement).disabled, { polling: 100 });
    await panel.$eval('footer form', el => (el as HTMLFormElement).requestSubmit());
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const state = await send<AppState>({ type: 'state' });
      if (state.run?.prompt === prompt && state.run.status !== 'running') {
        assert.equal(state.run.status, 'completed', state.run.message);
        return state;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Run timed out');
  };
  const first = await submit('検索アイコンを押して。');
  assert.equal(await page.$eval('#result', el => (el as HTMLElement).hidden), false);
  assert(first.run?.trace?.includes('NO_MATCH') && first.run.trace.includes('screenshot'));
  assert(captured);
  const savedImage = captured;
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/vision-labelled.jpg', Buffer.from(savedImage.base64, 'base64'));
  const pixel = await page.evaluate(async image => {
    const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return [...ctx.getImageData(160, 240, 1, 1).data];
  }, savedImage);
  assert(Math.abs(pixel[0] - 156) < 15 && Math.abs(pixel[1] - 163) < 15 && Math.abs(pixel[2] - 175) < 15, `Password field must be masked: ${pixel}; image ${savedImage.width}x${savedImage.height}`);
  console.info('PASS: DOM NO_MATCH -> masked, boxed/labelled screenshot -> AI-selected ref -> actual click');
  const second = await submit('前回の間違いは何でしたか？');
  assert(reflected); assert.equal(second.conversationId, first.conversationId);
  assert(!JSON.stringify(second).includes(savedImage.base64), 'Screenshot bytes must not be archived');
  await panel.waitForFunction(() => document.querySelectorAll('main section').length === 2, { polling: 100 });
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('main section').length === 2, { polling: 100 });
  console.info('PASS: follow-up receives earlier prompt, answer and errors; conversation survives reload');
  await panel.$eval('[aria-label="New conversation"]', el => (el as HTMLButtonElement).click());
  await panel.waitForFunction(() => document.querySelectorAll('main section').length === 0, { polling: 100 });
  await page.bringToFront();
  await panel.waitForFunction(() => document.querySelector('footer p')?.textContent?.includes('Visual fallback fixture'), { polling: 100 });
  await submit('新しい会話です。');
  assert(fresh);
  await panel.$eval('header nav button:last-child', el => (el as HTMLButtonElement).click());
  await panel.waitForFunction(() => document.querySelectorAll('main > button').length === 3, { polling: 100 });
  await panel.$eval('main > button:nth-of-type(2)', el => (el as HTMLButtonElement).click());
  await panel.waitForFunction(() => document.querySelectorAll('main section').length === 2, { polling: 100 });
  for (const width of [320, 410, 600]) {
    await panel.setViewport({ width, height: 480 });
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
  }
  assert.deepEqual(errors, []);
  console.info('PASS: New conversation isolates context; History reopens prior conversation; compact layout fits');
} finally {
  if (browser) await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}
