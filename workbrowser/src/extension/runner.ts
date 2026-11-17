import { createChromeController, LayerError, type ConfirmAnswer, type ConfirmRequest, type Session, type Result } from '../browser-control';
import { PlanSchema, PolicySchema, SAFE_TOOLS, modelAllowed, originOf, unrestricted, urlAllowed, writePermission, type Identity, type Policy, type Run } from '../shared/contracts';
import { runAgent } from '../agent/loop';
import { type AgentInfo, AgentTurnSchema, type ConversationTurn } from '../shared/agent';
import { appendTrace, conversationTurns } from '../shared/conversation';
import { activityEvent, appendEvent } from '../shared/activity';
import { prepareImage } from './vision';
import type { ScreenshotData } from '../browser-control';
import { api } from './api';
import { connection, finishRun, saveRun, state } from './storage';
import { ApprovalBroker } from './approvals';

type Authorize = (request: ConfirmRequest, answer: ConfirmAnswer) => Promise<void>;
let active: { abort: AbortController; run: Run; authorize?: Authorize } | null = null;
let starting = false;
const approvals = new ApprovalBroker(async request => {
  if (request) {
    if (active?.run.id === request.runId) {
      active.run.message = `Waiting for approval: ${request.action} ${request.target}`;
      appendEvent(active.run, { at: new Date().toISOString(), label: active.run.message, status: 'info' });
      await saveRun(active.run);
    }
    await chrome.storage.local.set({ pendingApproval: request });
  } else await chrome.storage.local.remove('pendingApproval');
});
const controller = createChromeController({ prompt: {
  confirm: (request, signal) => {
    const task = active;
    if (!task?.authorize) throw new LayerError('NEEDS_USER', 'There is no active task to approve.');
    return approvals.request(task.run.id, request, signal, answer => task.authorize!(request, answer));
  },
  // ask_user is not exposed; manual takeover still returns a USER_STEP for the user to perform in Chrome.
  ask: async () => ({ outcome: 'cancel' }),
} });
export const ready = (async () => {
  // A worker restart cannot establish whether an earlier write completed. Never replay it automatically.
  await chrome.storage.local.remove('pendingApproval');
  const old = (await state()).run;
  if (old?.status === 'running') await finishRun({ ...old, status: 'interrupted', message: 'The extension restarted. Check the last operation on the page before starting a new task.' });
})();

function layerPolicy(policy: Policy, email: string) {
  return { allow: unrestricted(policy, email) ? ['*'] : policy.allowedOrigins, deny: [] };
}
export async function stop(): Promise<void> {
  active?.abort.abort();
}
export async function answerApproval(id: string, runId: string, answer: ConfirmAnswer): Promise<void> {
  if (active?.run.id !== runId) throw new Error('This task is no longer active.');
  await approvals.answer(id, runId, answer);
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
    const previous = await state();
    const conversationId = previous.run?.mode === 'mock' ? crypto.randomUUID() : previous.conversationId ?? crypto.randomUUID();
    const conversation = conversationTurns(previous.history, conversationId);
    const run: Run = { id: crypto.randomUUID(), conversationId, prompt, tabId, startedAt: new Date().toISOString(), status: 'running', completed: 0, total: 0, message: 'Starting agent…', events: [], mode: 'agent', sources: [] };
    const abort = new AbortController();
    active = { abort, run };
    await saveRun(run);
    void executeAgent(run, abort, policy, me, conn, conversation);
  } finally { starting = false; }
}
async function executeAgent(run: Run, abort: AbortController, initialPolicy: Policy, me: Identity, conn: import('../shared/contracts').Connection, conversation: ConversationTurn[]): Promise<void> {
  let session: Session | undefined;
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(initialPolicy.maxMinutes * 60000)]);
  // Chrome APIs extend the worker lifetime while a first model call is pending, before debugger attachment.
  const heartbeat = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20000);
  let policy = initialPolicy;
  const controlPolicy = () => ({ allow: policy.modelOrigins.filter(origin => urlAllowed(policy, me.email, origin)), deny: [] });
  try {
    session = (await controller).createSession({
      urlPolicy: controlPolicy(), capabilities: ['vision'], observeDefault: 'full', budget: 18000, confirm: 'sensitive',
      decideWrite: async () => {
        const check = await checkpoint(run.sources ?? []);
        if (!check.canObserve) throw new LayerError('URL_NOT_ALLOWED', 'This site is no longer approved for browser actions.');
        const permission = writePermission(policy, check.url);
        if (permission.rule === 'block') throw new LayerError('WRITE_BLOCKED', 'The action rule for this site blocks submissions and deletions. Nothing was dispatched.');
        return permission.rule === 'allow'
          ? { decision: 'run', by: policy.writeRules.some(item => item.origin === originOf(check.url)) ? 'site-rule' : 'auto', canRemember: false }
          : { decision: 'ask', canRemember: me.admin && permission.canRemember };
      },
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
    active!.authorize = async (request, answer) => {
      const check = await checkpoint(run.sources ?? []);
      if (request.tabId !== run.tabId || originOf(check.url) !== request.origin) throw new LayerError('TARGET_CHANGED', 'The tab changed sites while approval was pending. Nothing was dispatched.');
      if (!check.canObserve) throw new LayerError('URL_NOT_ALLOWED', 'Access to this site was revoked while approval was pending.');
      const permission = writePermission(policy, check.url);
      if (permission.rule === 'block') throw new LayerError('WRITE_BLOCKED', 'The site action rule now blocks this operation. Nothing was dispatched.');
      if (answer === 'approve-remember') {
        if (!me.admin || !permission.canRemember) throw new LayerError('USER_DECLINED', 'The current settings require approval for each action.');
        const next = PolicySchema.parse({ ...policy, writeRules: [...policy.writeRules.filter(item => item.origin !== request.origin), { origin: request.origin, rule: 'allow' }] });
        policy = PolicySchema.parse(await api(conn, '/api/policy', { method: 'PUT', body: JSON.stringify(next), signal }));
        signal.throwIfAborted();
        await session!.setUrlPolicy(controlPolicy());
      }
    };
    const result = await runAgent(run.prompt, {
      signal, checkpoint,
      model: async request => AgentTurnSchema.parse(await api(conn, '/api/agent/turn', { method: 'POST', body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(100000)]) })),
      call: async (tool, args) => {
        signal.throwIfAborted();
        if (tool === 'navigate' && typeof args.url === 'string' && !modelAllowed(policy, me.email, args.url)) throw new Error('The destination is not approved for browsing and AI page access. Add its exact origin in Settings.');
        if (tool === 'wait' && typeof args.ms === 'number') args.ms = Math.min(args.ms, 15000);
        const result = await session!.call(tool, args, { signal });
        if (tool !== 'screenshot' || !result.ok) return result;
        try { return { ...result, data: await prepareImage(result.data as ScreenshotData) }; }
        catch (error) { return { ok: false, text: error instanceof Error ? error.message : 'Screenshot preparation failed.', error: { code: 'CAPTURE_FAILED', message: 'Screenshot preparation failed.', delivered: false, hint: 'Try a smaller viewport or finish with partial results.' } }; }
      },
      record: async (tool, args, result, sourceUrl) => {
        const currentUrl = (await chrome.tabs.get(run.tabId).catch(() => undefined))?.url;
        run.sources = [...new Set([...(run.sources ?? []), ...[sourceUrl, currentUrl].filter((url): url is string => !!url && !!originOf(url))])];
        appendEvent(run, activityEvent(tool, args, result, currentUrl ?? sourceUrl));
        run.trace = appendTrace(run.trace, tool, args, result); await saveRun(run);
      },
      progress: async (label, _status, progress) => {
        run.completed = progress.turns; run.notes = progress.notes; run.sources = progress.sources;
        run.message = label;
        await saveRun(run);
      },
      capture: async (text, url) => {
        const next = (run.extracted ?? '') + `\n\nSource: ${url}\n${text}`;
        run.extracted = next.slice(0, 200000);
        if (next.length > 200000) appendEvent(run, { at: new Date().toISOString(), label: 'Local text archive reached its 200,000 character limit.', status: 'info' });
        await saveRun(run);
      },
    }, conversation);
    run.output = result.answer; run.notes = result.notes; run.sources = result.sources; run.outcome = result.outcome;
    run.status = result.outcome === 'failed' ? 'failed' : 'completed';
    run.message = result.outcome === 'success' ? 'Task completed.' : result.outcome === 'partial' ? 'Partial results. See the answer for remaining work.' : 'The task could not be completed.';
  } catch (error) {
    run.status = abort.signal.aborted ? 'stopped' : 'failed';
    run.message = abort.signal.aborted ? 'Stopped. Actions already sent are not undone.' : signal.aborted ? 'Execution time limit reached.' : error instanceof Error ? error.message : 'Agent execution failed.';
    run.output = [run.message, run.notes].filter(Boolean).join('\n\n');
    run.outcome = 'partial';
    appendEvent(run, { at: new Date().toISOString(), label: run.message, status: 'error' });
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
    const run: Run = { id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt, tabId, startedAt: new Date().toISOString(), status: 'running', completed: 0, total: plan.steps.length, message: plan.message, events: [], mode: 'mock' };
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
    appendEvent(run, { at: new Date().toISOString(), label, status });
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
    appendEvent(run, activityEvent('snapshot', { mode: 'interactive' }, observed, (await chrome.tabs.get(run.tabId)).url));
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
      appendEvent(run, activityEvent(step.tool, step.args, result, (await chrome.tabs.get(run.tabId)).url));
      await saveRun(run);
      checkResult(result);
      if (step.tool === 'read') {
        const data = result.data as { content?: string; remaining?: number } | undefined;
        run.output = data?.content ?? '';
        if (data?.remaining) event('取得上限に達したため、ページの一部を保存しました。', 'info');
      }
      run.completed++;
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
