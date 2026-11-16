import type { Result } from '../browser-control';
import { AgentTurnSchema, DoneSchema, RememberSchema, type AgentRequest, type AgentTurn, type Done, type ToolReply } from '../shared/agent';
import { validateCall } from './tools';

export interface AgentPorts {
  signal: AbortSignal;
  /** Refreshes limits, checks all context sources, and returns the current tab URL. */
  checkpoint(sources: string[]): Promise<{ url: string; maxSteps: number; canObserve: boolean }>;
  model(request: AgentRequest): Promise<AgentTurn>;
  call(tool: string, args: Record<string, unknown>): Promise<Result>;
  progress(label: string, status: 'ok' | 'error' | 'info', state: { turns: number; notes: string; sources: string[] }): Promise<void>;
  capture?(text: string, url: string): Promise<void>;
}

/** Bound old page payloads without breaking function-call/signature pairs or losing the user's instruction. */
export function trimContext(context: AgentRequest): void {
  if (JSON.stringify(context).length < 120000) return;
  // Never silently elide evidence until the model has preserved it in working notes.
  if (!context.notes) return;
  if (context.initial) context.initial.text = '[Earlier observation elided. Use working notes or read again.]';
  for (const exchange of context.history.slice(0, -8)) {
    for (const result of exchange.results) if (result.text.length > 350) result.text = '[Earlier result elided. Consult working notes; read the source again if necessary.]';
  }
}

export async function runAgent(prompt: string, ports: AgentPorts): Promise<Done & { sources: string[]; notes: string }> {
  const context: AgentRequest = { prompt, currentUrl: '', notes: '', history: [], sources: [], finishOnly: false };
  const sources = new Set<string>();
  let turns = 0, errors = 0, observed = false, initial = true;
  let noProgress = 0, forceFinish = false;
  const recent: string[] = [];
  const report = (label: string, status: 'ok' | 'error' | 'info') => ports.progress(label, status, { turns, notes: context.notes, sources: [...sources] });
  const partial = (reason: string) => ({ outcome: 'partial' as const, answer: [reason, context.notes].filter(Boolean).join('\n\n'), sources: [...sources], notes: context.notes });
  for (;;) {
    ports.signal.throwIfAborted();
    const check = await ports.checkpoint([...sources]);
    context.currentUrl = check.canObserve ? check.url : '';
    if (initial) {
      initial = false;
      if (check.canObserve) {
        const result = await ports.call('snapshot', { mode: 'all', window: 'near' });
        if (result.ok) {
          observed = true; sources.add(check.url);
          context.initial = { url: check.url, text: bounded(result.text) };
        }
      }
    }
    if (turns >= check.maxSteps) return partial('The configured agent turn limit was reached. Results collected so far:');
    context.finishOnly = forceFinish || turns >= check.maxSteps - 1 || errors >= 4 || noProgress >= 4;
    context.sources = [...sources];
    trimContext(context);
    if (new TextEncoder().encode(JSON.stringify(context)).length > 1800000) return partial('The context limit was reached. Narrow the task or process fewer pages per run.');
    await report(context.finishOnly ? 'Preparing the final answer…' : 'Choosing the next step…', 'info');
    const response = AgentTurnSchema.parse(await ports.model(structuredClone(context)));
    ports.signal.throwIfAborted();
    turns++;
    const calls = response.content.parts.flatMap(p => p.functionCall ? [p.functionCall] : []);
    if (!calls.length) throw new Error('AI returned no executable call.');
    const results: ToolReply[] = [];
    // At most one call is executed per response. Every additional native call gets a matching skipped response.
    // This preserves provider history without dispatching a stale batch after navigation.
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      if (index > 0) {
        results.push({ name: call.name, id: call.id, ok: false, text: 'Not executed. Only the first call runs per turn. Inspect its result and choose again.' });
        continue;
      }
      let args: Record<string, unknown>;
      try { args = validateCall(call); }
      catch {
        errors++;
        results.push({ name: call.name, id: call.id, ok: false, text: 'Invalid arguments. Use the tool schema, current refs and an explicit target for key input. No action was dispatched.' });
        await report(`${call.name}: invalid arguments`, 'error');
        continue;
      }
      if (context.finishOnly && call.name !== 'done') return partial('The agent reached its progress or execution limit. Results collected so far:');
      if (call.name === 'done') {
        const done = DoneSchema.parse(args);
        if (done.outcome === 'success' && !observed && !context.finishOnly) {
          errors++;
          results.push({ name: call.name, id: call.id, ok: false, text: 'No browser evidence has been observed. Read the current page or navigate to the requested site first; do not invent a successful result.' });
          continue;
        }
        if (context.finishOnly && done.outcome === 'success') done.outcome = 'partial';
        await report('Answer ready', 'ok');
        return { ...done, sources: [...sources], notes: context.notes };
      }
      if (call.name === 'remember') {
        context.notes = RememberSchema.parse(args).notes;
        errors = 0;
        results.push({ name: call.name, id: call.id, ok: true, text: 'Working notes updated.' });
        await report('Saved working notes', 'ok');
        continue;
      }
      // Refresh policy again immediately before dispatch, including after a slow model call.
      const latest = await ports.checkpoint([...sources]);
      if (call.name !== 'navigate' && !latest.canObserve) throw new Error('The current page is not approved for AI page access.');
      const result = await ports.call(call.name, args);
      ports.signal.throwIfAborted();
      // Ambiguous dispatch is never replayed, even if the model would like to try again.
      if ((!result.ok && result.error?.delivered !== false) || result.receipt?.dispatched === 'unknown' || result.receipt?.reachedTarget === false || result.receipt?.postcondition?.status === 'unmet' || result.pageError) {
        throw new Error('The browser could not verify the last operation. Stopped to avoid repeating it. Check the page before starting again.');
      }
      if (!result.ok && ['USER_STEP', 'NEEDS_USER', 'USER_DECLINED', 'URL_NOT_ALLOWED', 'CANCELLED'].includes(result.error?.code ?? '')) {
        forceFinish = true;
        results.push({ name: call.name, id: call.id, ok: false, text: bounded(`${result.text}\nA manual step or administrator change is required. Finish with a partial answer in the user's language; do not try another action.`) });
        await report('Manual step or administrator change required', 'info');
        continue;
      }
      const after = await ports.checkpoint([...sources]);
      const url = after.canObserve ? after.url : undefined;
      if (url) sources.add(url);
      const text = bounded(result.text);
      results.push({ name: call.name, id: call.id, ok: result.ok, text, url });
      if (result.ok) observed = true;
      if (call.name === 'read' && result.ok && url) {
        const content = (result.data as { content?: string } | undefined)?.content;
        if (content) await ports.capture?.(content, url);
      }
      errors = result.ok ? 0 : errors + 1;
      const meaningful = Object.fromEntries(Object.entries(args).filter(([key]) => !['intent', 'timeoutMs', 'observe'].includes(key)));
      const sig = JSON.stringify([call.name, meaningful, result.ok, after.url]);
      recent.push(sig);
      if (recent.length > 8) recent.shift();
      const repeated = recent.filter(s => s === sig).length >= 3;
      const ineffective = result.receipt?.effect.verdict === 'none' && result.receipt.postcondition?.status !== 'met';
      noProgress = repeated || ineffective ? noProgress + 1 : 0;
      if (repeated) results[results.length - 1].text += '\nRepeated call: try a different approach or finish with partial results.';
      if (call.name === 'read' && !context.notes && turns >= 6) results[results.length - 1].text += '\nUse remember now to preserve extracted facts and source URLs for longer tasks.';
      await report(`${call.name}${result.ok ? '' : `: ${result.error?.code ?? 'error'}`}`, result.ok ? 'ok' : 'error');
    }
    context.history.push({ model: response.content, results });
  }
}

/** Keep the end of the untrusted-content boundary when a result is larger than the transport budget. */
function bounded(text: string): string {
  if (text.length <= 22000) return text;
  return text.slice(0, 20500) + '\n[Result truncated; use read with offset or a narrower scope.]\n' + text.slice(-1000);
}
