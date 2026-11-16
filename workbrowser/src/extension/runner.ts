import { createChromeController, type Session, type Result } from '../browser-control';
import { PlanSchema, PolicySchema, SAFE_TOOLS, modelAllowed, unrestricted, urlAllowed, type Identity, type Policy, type Run } from '../shared/contracts';
import { runAgent } from '../agent/loop';
import { type AgentInfo, AgentTurnSchema } from '../shared/agent';
import { api } from './api';
import { connection, finishRun, saveRun, state } from './storage';

let active: { abort: AbortController; run: Run } | null = null;
let starting = false;
const controller = createChromeController();
export const ready = (async () => {
  // A worker restart cannot establish whether an earlier write completed. Never replay it automatically.
  const old = (await state()).run;
  if (old?.status === 'running') await finishRun({ ...old, status: 'interrupted', message: 'The extension restarted. Check the last operation on the page before starting a new task.' });
})();

function layerPolicy(policy: Policy, email: string) {
  return { allow: unrestricted(policy, email) ? ['*'] : policy.allowedOrigins, deny: [] };
}
export async function stop(): Promise<void> {
  active?.abort.abort();
}
export async function begin(prompt: string, tabId: number, mode: 'agent' | 'mock' = 'agent'): Promise<void> {
  if (mode === 'mock') return beginMock(prompt, tabId);
  await ready;
  if (starting || active) throw new Error('A task is already running. Stop it or wait until it finishes.');
  starting = true;
  try {
    const conn = await connection();
    const me = await api<Identity>(conn, '/api/me');
    const policy = PolicySchema.parse(await api(conn, '/api/policy'));
    const info = await api<AgentInfo>(conn, '/api/agent/info');
    if (!info.configured) throw new Error('AI is not configured. Open Settings and follow the company setup guide. Demo mode is available for offline checks.');
    await chrome.tabs.get(tabId);
    const run: Run = { id: crypto.randomUUID(), prompt, tabId, startedAt: new Date().toISOString(), status: 'running', completed: 0, total: 0, message: 'Starting agent…', events: [], mode: 'agent', sources: [] };
    const abort = new AbortController();
    active = { abort, run };
    await saveRun(run);
    void executeAgent(run, abort, policy, me, conn);
  } finally { starting = false; }
}
async function executeAgent(run: Run, abort: AbortController, initialPolicy: Policy, me: Identity, conn: import('../shared/contracts').Connection): Promise<void> {
  let session: Session | undefined;
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(initialPolicy.maxMinutes * 60000)]);
  // Chrome APIs extend the worker lifetime while a first model call is pending, before debugger attachment.
  const heartbeat = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20000);
  let policy = initialPolicy;
  const controlPolicy = () => ({ allow: policy.modelOrigins.filter(origin => urlAllowed(policy, me.email, origin)), deny: [] });
  try {
    session = (await controller).createSession({
      urlPolicy: controlPolicy(), observeDefault: 'full', budget: 18000, confirm: 'sensitive',
      // Scraping sessions stop on detected business writes; search/navigation are classified as read actions.
      decideWrite: () => ({ decision: 'ask', canRemember: false }),
      handover: true, reveal: () => false,
    });
    // The host shares only the selected tab. Explicit navigate may leave a new-tab or unapproved page.
    session.shareTab(run.tabId);
    const checkpoint = async (sources: string[]) => {
      signal.throwIfAborted();
      policy = PolicySchema.parse(await api(conn, '/api/policy', { signal }));
      if (Date.now() - Date.parse(run.startedAt) >= policy.maxMinutes * 60000) throw new Error('The administrator execution time limit was reached.');
      if (sources.some(url => !modelAllowed(policy, me.email, url))) throw new Error('AI page access was revoked for a source site. Stopped before sending more page data.');
      await session!.setUrlPolicy(controlPolicy());
      const tab = await chrome.tabs.get(run.tabId);
      const url = tab.url ?? '';
      return { url, maxSteps: policy.maxSteps, canObserve: modelAllowed(policy, me.email, url) };
    };
    const result = await runAgent(run.prompt, {
      signal, checkpoint,
      model: async request => AgentTurnSchema.parse(await api(conn, '/api/agent/turn', { method: 'POST', body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(100000)]) })),
      call: async (tool, args) => {
        signal.throwIfAborted();
        if (tool === 'navigate' && typeof args.url === 'string' && !modelAllowed(policy, me.email, args.url)) throw new Error('The destination is not approved for browsing and AI page access. Add its exact origin in Settings.');
        if (tool === 'wait' && typeof args.ms === 'number') args.ms = Math.min(args.ms, 15000);
        return session!.call(tool, args, { signal });
      },
      progress: async (label, status, progress) => {
        run.completed = progress.turns; run.notes = progress.notes; run.sources = progress.sources;
        run.message = label;
        run.events.push({ at: new Date().toISOString(), label, status });
        if (run.events.length > 500) run.events.shift();
        await saveRun(run);
      },
      capture: async (text, url) => {
        const next = (run.extracted ?? '') + `\n\nSource: ${url}\n${text}`;
        run.extracted = next.slice(0, 200000);
        if (next.length > 200000) run.events.push({ at: new Date().toISOString(), label: 'Local text archive reached its 200,000 character limit.', status: 'info' });
        await saveRun(run);
      },
    });
    run.output = result.answer; run.notes = result.notes; run.sources = result.sources; run.outcome = result.outcome;
    run.status = result.outcome === 'failed' ? 'failed' : 'completed';
    run.message = result.outcome === 'success' ? 'Task completed.' : result.outcome === 'partial' ? 'Partial results. See the answer for remaining work.' : 'The task could not be completed.';
  } catch (error) {
    run.status = abort.signal.aborted ? 'stopped' : 'failed';
    run.message = abort.signal.aborted ? 'Stopped. Actions already sent are not undone.' : signal.aborted ? 'Execution time limit reached.' : error instanceof Error ? error.message : 'Agent execution failed.';
    run.output = [run.message, run.notes].filter(Boolean).join('\n\n');
    run.outcome = 'partial';
    run.events.push({ at: new Date().toISOString(), label: run.message, status: 'error' });
  } finally {
    clearInterval(heartbeat);
    if (session) await (await controller).closeSession(session).catch(() => undefined);
    run.total = run.completed;
    await finishRun(run);
    active = null;
  }
}
async function beginMock(prompt: string, tabId: number): Promise<void> {
  await ready;
  if (starting || active) throw new Error('実行中のタスクがあります。停止または完了を待ってください。');
  starting = true;
  try {
    const conn = await connection();
    const me = await api<Identity>(conn, '/api/me');
    const policy = PolicySchema.parse(await api(conn, '/api/policy'));
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !urlAllowed(policy, me.email, tab.url)) throw new Error('このサイトは許可されていません。設定画面で許可リストを確認してください。');
    const url = new URL(tab.url);
    const plan = PlanSchema.parse(await api(conn, '/api/agent/plan', { method: 'POST', body: JSON.stringify({ prompt, url: url.origin + url.pathname }) }));
    if (plan.steps.length > policy.maxSteps) throw new Error('操作数の上限を超えています。');
    const run: Run = { id: crypto.randomUUID(), prompt, tabId, startedAt: new Date().toISOString(), status: 'running', completed: 0, total: plan.steps.length, message: plan.message, events: [], mode: 'mock' };
    const abort = new AbortController();
    active = { abort, run };
    await saveRun(run);
    void execute(run, abort, plan.steps, policy, me, conn);
  } finally { starting = false; }
}
async function execute(run: Run, abort: AbortController, steps: import('../shared/contracts').Plan['steps'], initialPolicy: Policy, me: Identity, conn: import('../shared/contracts').Connection): Promise<void> {
  let session: Session | undefined;
  const deadline = Date.now() + initialPolicy.maxMinutes * 60000;
  const event = (label: string, status: 'ok' | 'error' | 'info') => {
    run.events.push({ at: new Date().toISOString(), label, status });
    if (run.events.length > 500) run.events.shift();
  };
  try {
    if (!steps.length) { run.status = 'completed'; return; }
    session = (await controller).createSession({
      urlPolicy: layerPolicy(initialPolicy, me.email), observeDefault: 'none', budget: 18000,
      confirm: 'never', decideWrite: () => ({ decision: 'run', by: 'auto', canRemember: false }),
      handover: true, uploadSources: ['attachments'], reveal: () => false,
    });
    await session.share(run.tabId);
    // Observe locally to establish node identity; page text is not sent to the mock server.
    const observed = await session.call('snapshot', { mode: 'interactive' }, { signal: abort.signal });
    checkResult(observed);
    for (const step of steps) {
      abort.signal.throwIfAborted();
      if (Date.now() > deadline) throw new Error('実行時間の上限に達しました。');
      const latest = PolicySchema.parse(await api(conn, '/api/policy', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) }));
      if (run.completed >= latest.maxSteps || Date.now() - Date.parse(run.startedAt) > latest.maxMinutes * 60000) throw new Error('管理者が設定した実行上限に達しました。');
      if (!SAFE_TOOLS.includes(step.tool)) throw new Error('許可されていない操作です。');
      if ((step.tool === 'type' || step.tool === 'press') && !step.args.target) throw new Error('キー入力には許可された対象要素の指定が必要です。');
      // The model may never choose a different tab or policy. Only this shared tab is in scope in v0.1.
      if ('tabId' in step.args && step.args.tabId !== run.tabId) throw new Error('作業対象外のタブへの操作です。');
      const tab = await chrome.tabs.get(run.tabId);
      if (!tab.url || !urlAllowed(latest, me.email, tab.url)) throw new Error('許可リストの変更または画面移動により停止しました。');
      await session.setUrlPolicy(layerPolicy(latest, me.email));
      run.message = step.label;
      await saveRun(run);
      abort.signal.throwIfAborted();
      const result = await session.call(step.tool, step.args, { signal: abort.signal });
      checkResult(result);
      if (step.tool === 'read') {
        const data = result.data as { content?: string; remaining?: number } | undefined;
        run.output = data?.content ?? '';
        if (data?.remaining) event('取得上限に達したため、ページの一部を保存しました。', 'info');
      }
      run.completed++;
      event(step.label, 'ok');
      await saveRun(run);
    }
    run.status = 'completed';
    run.message = `${run.completed}ステップが完了しました。`;
  } catch (e) {
    run.status = abort.signal.aborted ? 'stopped' : 'failed';
    run.message = abort.signal.aborted ? '停止しました。送信済みの操作は取り消されません。' : (e instanceof Error ? e.message : '実行に失敗しました。');
    event(run.message, run.status === 'stopped' ? 'info' : 'error');
  } finally {
    if (session) await (await controller).closeSession(session).catch(() => undefined);
    await finishRun(run);
    active = null;
  }
}
function checkResult(result: Result): void {
  if (!result.ok) throw new Error(`${result.error?.code ?? 'ERROR'}: ${result.error?.message ?? result.text}`);
  if (result.pageError || result.receipt?.dispatched === 'unknown' || result.receipt?.reachedTarget === false || result.receipt?.postcondition?.status === 'unmet') {
    throw new Error('操作結果を確認できませんでした。二重実行を避けるため停止しました。画面を確認してください。');
  }
}
