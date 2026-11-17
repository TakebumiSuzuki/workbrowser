import type { Result } from '../browser-control';
import { AgentTurnSchema, DoneSchema, ImageSchema, RememberSchema, type AgentImage, type AgentRequest, type AgentTurn, type ConversationTurn, type Done, type ToolReply } from '../shared/agent';
import { validateCall } from './tools';

export interface AgentPorts {
  signal: AbortSignal;
  /** Refreshes limits, checks all context sources, and returns the current tab URL. */
  checkpoint(sources: string[]): Promise<{ url: string; maxSteps: number; canObserve: boolean }>;
  model(request: AgentRequest): Promise<AgentTurn>;
  call(tool: string, args: Record<string, unknown>): Promise<Result>;
  progress(label: string, status: 'ok' | 'error' | 'info', state: { turns: number; notes: string; sources: string[] }): Promise<void>;
  capture?(text: string, url: string): Promise<void>;
  record?(tool: string, args: Record<string, unknown>, result: Result, sourceUrl?: string): Promise<void>;
}

/** Bound old page payloads without breaking function-call/signature pairs or losing the user's instruction. */
export function trimContext(context: AgentRequest): void {
  if (JSON.stringify(context, (key, value) => key === 'image' ? undefined : value).length < 120000) return;
  // Never silently elide evidence until the model has preserved it in working notes.
  if (!context.notes) return;
  if (context.initial) context.initial.text = '[Earlier observation elided. Use working notes or read again.]';
  for (const exchange of context.history.slice(0, -8)) {
    for (const result of exchange.results) if (result.text.length > 350) result.text = '[Earlier result elided. Consult working notes; read the source again if necessary.]';
  }
}

export async function runAgent(prompt: string, ports: AgentPorts, conversation: ConversationTurn[] = []): Promise<Done & { sources: string[]; notes: string }> {
  const context: AgentRequest = { prompt, currentUrl: '', notes: '', history: [], sources: [], finishOnly: false, ...(conversation.length ? { conversation: structuredClone(conversation) } : {}) };
  const sources = new Set<string>(conversation.flatMap(turn => turn.sources));
  let turns = 0, errors = 0, initial = true;
  let noProgress = 0, forceFinish = false;
  const recent: string[] = [];
  const report = (label: string, status: 'ok' | 'error' | 'info') => ports.progress(label, status, { turns, notes: context.notes, sources: [...sources] });
  const partial = (reason: string) => ({ outcome: 'partial' as const, answer: [reason, context.notes].filter(Boolean).join('\n\n'), sources: [...sources], notes: context.notes });
  const captureVisual = async (): Promise<Result & { url?: string; image?: AgentImage }> => {
    const before = await ports.checkpoint([...sources]);
    if (!before.canObserve) throw new Error('The current page is not approved for AI image access.');
    const args = validateCall({ name: 'screenshot', args: {} });
    const result = await ports.call('screenshot', args);
    ports.signal.throwIfAborted();
    await ports.record?.('screenshot', args, result, before.url);
    const after = await ports.checkpoint([...sources]);
    if (!after.canObserve || after.url !== before.url) throw new Error('The page changed while taking the screenshot. Observe the current page again.');
    const image = result.ok ? imageOf(result) : undefined;
    if (!image) return { ...result, ok: false, text: `Visual fallback unavailable: ${result.text}`, error: result.error ?? { code: 'CAPTURE_FAILED', message: 'No usable screenshot was returned.', delivered: false, hint: 'Use DOM observation or finish with partial results.' } };
    clearImages(context);
    sources.add(after.url);
    return { ...result, url: after.url, image };
  };
  for (;;) {
    ports.signal.throwIfAborted();
    const check = await ports.checkpoint([...sources]);
    context.currentUrl = check.canObserve ? check.url : '';
    if (initial) {
      initial = false;
      if (check.canObserve && !conversation.length) {
        const result = await ports.call('snapshot', { mode: 'all', window: 'near' });
        await ports.record?.('snapshot', { mode: 'all', window: 'near' }, result, check.url);
        if (result.ok) {
          sources.add(check.url);
          context.initial = { url: check.url, text: bounded(result.text) };
        } else if (result.error?.code === 'CAPTURE_FAILED' && result.error.delivered === false) {
          const visual = await captureVisual();
          if ('image' in visual && visual.image) {
            context.initial = { url: visual.url!, text: bounded(`DOM observation failed. Visual fallback: ${visual.text}`), image: visual.image };
          }
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
        await ports.record?.(call.name, call.args, results.at(-1)!);
        continue;
      }
      if (context.finishOnly && call.name !== 'done') return partial('The agent reached its progress or execution limit. Results collected so far:');
      if (call.name === 'done') {
        const done = DoneSchema.parse(args);
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
      const result = call.name === 'screenshot' ? await captureVisual() : await ports.call(call.name, args);
      ports.signal.throwIfAborted();
      if (call.name !== 'screenshot') await ports.record?.(call.name, args, result, latest.url);
      // Ambiguous dispatch is never replayed, even if the model would like to try again.
      if ((!result.ok && result.error?.delivered !== false) || result.receipt?.dispatched === 'unknown' || result.receipt?.reachedTarget === false || result.receipt?.postcondition?.status === 'unmet' || result.pageError) {
        throw new Error('The browser could not verify the last operation. Stopped to avoid repeating it. Check the page before starting again.');
      }
      if (!result.ok && ['USER_STEP', 'NEEDS_USER', 'USER_DECLINED', 'WRITE_BLOCKED', 'CONFIRMATION_TIMEOUT', 'URL_NOT_ALLOWED', 'CANCELLED'].includes(result.error?.code ?? '')) {
        forceFinish = true;
        results.push({ name: call.name, id: call.id, ok: false, text: bounded(`${result.text}\nA manual step or administrator change is required. Finish with a partial answer in the user's language; do not try another action.`) });
        await report('Manual step or administrator change required', 'info');
        continue;
      }
      const after = await ports.checkpoint([...sources]);
      const url = after.canObserve ? after.url : undefined;
      if (url) sources.add(url);
      const reply: ToolReply = { name: call.name, id: call.id, ok: result.ok, text: bounded(result.text), url };
      if (call.name === 'screenshot' && result.ok) reply.image = imageOf(result);
      if (!result.ok && result.error?.delivered === false && ['NO_MATCH', 'AMBIGUOUS_TARGET', 'NOT_INTERACTABLE'].includes(result.error.code)) {
        await report('DOM target unresolved. Inspecting a labelled screenshot…', 'info');
        const visual = await captureVisual();
        reply.text = bounded(`${result.text}\nVisual fallback: ${visual.text}\nChoose a visible ref label from the image; do not repeat the unresolved target.`);
        if ('image' in visual && visual.image) { reply.image = visual.image; reply.url = visual.url; }
      } else if (result.ok && !['snapshot', 'read', 'find', 'screenshot'].includes(call.name)) clearImages(context);
      results.push(reply);
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

function imageOf(result: Result) {
  const data = result.data as Record<string, unknown> | undefined;
  const parsed = ImageSchema.safeParse(data && { mimeType: data.mimeType, base64: data.base64, width: data.width, height: data.height });
  return parsed.success ? parsed.data : undefined;
}

/** Only the latest screen is sent; old tool calls and their signatures still keep their matching text results. */
function clearImages(context: AgentRequest): void {
  if (context.initial) delete context.initial.image;
  for (const exchange of context.history) for (const result of exchange.results) delete result.image;
}

/** Keep the end of the untrusted-content boundary when a result is larger than the transport budget. */
function bounded(text: string): string {
  if (text.length <= 22000) return text;
  return text.slice(0, 20500) + '\n[Result truncated; use read with offset or a narrower scope.]\n' + text.slice(-1000);
}
