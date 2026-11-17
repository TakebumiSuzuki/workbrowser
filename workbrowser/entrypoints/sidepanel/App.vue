<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { send, errorMessage } from '../../src/ui/bridge';
import { getExecutionMode, type ExecutionMode } from '../../src/ui/preferences';
import { conversationIdOf } from '../../src/shared/conversation';
import type { AppState, Run } from '../../src/shared/contracts';
import type { ConfirmAnswer } from '../../src/browser-control';
const state = ref<AppState>();
const prompt = ref('');
const promptInput = ref<HTMLTextAreaElement>();
const mode = ref<ExecutionMode>('agent');
const error = ref('');
const pending = ref(false);
const answeringApproval = ref(false);
const approval = computed(() => state.value?.pendingApproval?.runId === state.value?.run?.id ? state.value?.pendingApproval : null);
const tab = ref<chrome.tabs.Tab>();
const view = ref<'chat' | 'history'>('chat');
const messages = ref<HTMLElement>();
const followLatest = ref(true);
const conversationRuns = computed(() => {
  const current = state.value;
  if (!current?.conversationId) return [];
  const runs = current.history.filter(run => conversationIdOf(run) === current.conversationId).slice().reverse();
  if (current.run && !runs.some(run => run.id === current.run!.id)) runs.push(current.run);
  return runs;
});
const running = computed(() => state.value?.run?.status === 'running');
const examples = computed(() => mode.value === 'mock'
  ? ['ページのテキストを取得', '「検索」に「顧客 001」を入力', '「検索する」をクリック']
  : ['Summarize this page and highlight the key points.',
    'Extract names, dates and amounts from this page as a table.',
    'Follow the relevant links on this site and compare the available plans. Include source URLs.']);
function statusLabel(value: Run) {
  if (value.outcome === 'partial') return 'Partial results';
  return ({ running: 'Running', completed: 'Completed', stopped: 'Stopped', failed: 'Needs attention', interrupted: 'Interrupted' })[value.status];
}
async function refresh() {
  try {
    const [latestState, preferredMode] = await Promise.all([send<AppState>({ type: 'state' }), getExecutionMode()]);
    state.value = latestState;
    mode.value = running.value ? state.value.run?.mode ?? preferredMode : preferredMode;
    tab.value = state.value.run?.status === 'running'
      ? await chrome.tabs.get(state.value.run.tabId).catch(() => undefined)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  } catch (e) { error.value = errorMessage(e); }
}
async function start() {
  if (running.value || pending.value || !tab.value?.id || !prompt.value.trim()) return;
  error.value = ''; pending.value = true; followLatest.value = true;
  try { await send({ type: 'start', prompt: prompt.value, tabId: tab.value.id, mode: mode.value }); prompt.value = ''; await refresh(); }
  catch (e) { error.value = errorMessage(e); }
  finally { pending.value = false; }
}
async function stop() { try { await send({ type: 'stop' }); } catch (e) { error.value = errorMessage(e); } }
function settings() { void chrome.runtime.openOptionsPage(); }
async function answerApproval(answer: ConfirmAnswer) {
  const request = approval.value;
  if (!request || answeringApproval.value) return;
  answeringApproval.value = true; error.value = '';
  try { await send({ type: 'answer-approval', id: request.id, runId: request.runId, answer }); await refresh(); }
  catch (e) { error.value = errorMessage(e); await refresh(); }
  finally { answeringApproval.value = false; }
}
watch(() => approval.value?.id, id => { if (id) view.value = 'chat'; });
async function openConversation(id?: string) {
  error.value = ''; pending.value = true;
  try { await send({ type: 'open-conversation', ...(id ? { id } : {}) }); prompt.value = ''; view.value = 'chat'; followLatest.value = true; await refresh(); }
  catch (e) { error.value = errorMessage(e); }
  finally { pending.value = false; }
}
function scrolled() {
  const element = messages.value;
  if (element) followLatest.value = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
}
watch(() => [view.value, ...conversationRuns.value.map(run => `${run.id}:${run.status}:${run.message}:${run.output?.length ?? 0}`)].join('|'), () => {
  if (view.value === 'chat' && followLatest.value && messages.value) messages.value.scrollTop = messages.value.scrollHeight;
}, { flush: 'post' });
function storageChanged() { void refresh(); }
let timer: ReturnType<typeof setInterval>;
function resizePrompt() {
  const input = promptInput.value;
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}
watch(prompt, resizePrompt, { flush: 'post' });
watch(promptInput, (input, _, onCleanup) => {
  if (!input) return;
  resizePrompt();
  let width = input.clientWidth;
  const observer = new ResizeObserver(() => {
    if (input.clientWidth !== width) { width = input.clientWidth; resizePrompt(); }
  });
  observer.observe(input);
  onCleanup(() => observer.disconnect());
}, { flush: 'post' });
onMounted(async () => {
  void refresh();
  chrome.storage.onChanged.addListener(storageChanged);
  timer = setInterval(() => void refresh(), 4000);
});
onUnmounted(() => { clearInterval(timer); chrome.storage.onChanged.removeListener(storageChanged); });
function exportText(text: string | undefined, filename: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text ?? ''], { type: 'text/plain;charset=utf-8' }));
  a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
</script>
<template>
  <div class="flex h-dvh min-w-[320px] flex-col">
    <header class="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
      <div class="flex min-w-0 items-center gap-2"><span aria-hidden="true" class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-800 text-sm font-bold text-white">w.</span><h1 class="truncate text-sm font-semibold">Workbrowser</h1></div>
      <div class="flex shrink-0 items-center gap-1">
        <button class="rounded-lg p-2" aria-label="New conversation" title="New conversation" :disabled="running || pending" @click="openConversation()">＋</button>
        <nav aria-label="Conversation views" class="flex gap-1 text-xs"><button v-for="item in [{id:'chat',label:'Chat'},{id:'history',label:'History'}]" :key="item.id" class="rounded-lg px-2 py-2" :class="view === item.id ? 'bg-emerald-50 font-semibold text-emerald-900' : 'text-slate-500'" :aria-current="view === item.id ? 'page' : undefined" @click="view = item.id as 'chat' | 'history'">{{ item.label }}</button></nav>
        <button class="rounded-lg p-2" aria-label="Settings" title="Settings" @click="settings">⚙</button>
      </div>
    </header>
    <main ref="messages" class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3" @scroll="scrolled">
      <p v-if="error" role="alert" class="mb-4 rounded-xl bg-red-50 p-3 text-xs leading-6 text-red-800">{{ error }}</p>
      <template v-if="view === 'history'">
        <p class="mb-4 text-xs text-slate-400">The latest 20 tasks are saved locally. Open one to continue its conversation.</p>
        <p v-if="!state?.history.length" class="text-sm text-slate-400">No runs yet.</p>
        <button v-for="item in state?.history" :key="item.id" class="mb-2 block w-full rounded-xl border bg-white p-4 text-left" :disabled="running || pending" @click="openConversation(conversationIdOf(item))"><span class="mb-2 block truncate text-sm">{{ item.prompt }}</span><span class="text-xs text-slate-400">{{ statusLabel(item) }} · {{ item.completed }} steps</span></button>
      </template>
      <template v-if="view === 'chat' && !conversationRuns.length">
        <div class="pt-3"><h2 class="text-2xl font-semibold leading-relaxed">What would you like to find?</h2><p class="mt-3 text-xs leading-6 text-slate-500">Ask in English, Japanese, or another language. Work with this page, or include a URL to visit. The agent reads pages, chooses actions, and returns an answer with sources.</p></div>
        <div class="mt-5 space-y-2"><button v-for="example in examples" :key="example" class="block w-full rounded-xl border bg-white px-4 py-3 text-left text-xs leading-6 hover:border-emerald-500" @click="prompt = example">{{ example }}</button></div>
      </template>
      <template v-if="view === 'chat'">
      <section v-for="run in conversationRuns" :key="run.id" class="space-y-4">
        <div class="rounded-2xl bg-emerald-800 px-4 py-3 text-sm leading-6 text-white">{{ run.prompt }}</div>
        <div class="card"><div class="flex justify-between text-xs font-semibold"><span>{{ statusLabel(run) }}</span><span>{{ run.completed }}{{ run.mode === 'mock' ? ` / ${run.total}` : '' }} steps</span></div><p class="mt-3 text-xs leading-6" aria-live="polite">{{ run.message }}</p></div>
        <details v-if="run.events.length || run.trace" data-activity class="card">
          <summary class="cursor-pointer text-xs">Activity · {{ run.events.length }}</summary>
          <p v-if="run.activityTruncated" class="mt-3 text-[11px] text-slate-500">Earlier activity was omitted to stay within the history limit.</p>
          <p v-if="run.status !== 'running' && !run.events.some(event => event.action)" class="mt-3 text-[11px] text-slate-500">Detailed activity entries were not saved for this task.<span v-if="run.trace"> Any available technical details are in the raw log below.</span></p>
          <ol class="mt-3 max-h-80 space-y-3 overflow-y-auto">
            <li v-for="(event, i) in run.events" :key="i" class="space-y-1 border-b border-slate-100 pb-3 text-xs last:border-0 last:pb-0">
              <p class="font-medium" :class="event.status === 'error' ? 'text-red-600' : 'text-slate-700'">{{ event.status === 'ok' ? '✓' : event.status === 'error' ? '✕' : '·' }} {{ event.label }}</p>
              <p v-if="event.action?.target" class="whitespace-pre-wrap break-words text-slate-600">{{ event.action.target }}</p>
              <a v-if="event.action?.url" :href="event.action.url" target="_blank" rel="noopener noreferrer" class="block break-all text-[11px] text-emerald-700 underline">{{ event.action.url }}</a>
              <p v-if="event.action?.detail" class="whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-500">{{ event.action.detail }}</p>
            </li>
          </ol>
          <details v-if="run.trace" class="mt-3 border-t border-slate-100 pt-3"><summary class="cursor-pointer text-[11px] text-slate-400">Raw operation log</summary><pre class="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-500">{{ run.trace }}</pre></details>
        </details>
        <div v-if="run.output" class="card"><div class="mb-3 flex justify-between"><h3 class="text-xs font-semibold">Answer</h3><button class="text-xs text-emerald-700" @click="exportText(run.output, 'workbrowser-answer.txt')">Save ↓</button></div><pre class="whitespace-pre-wrap break-words font-sans text-sm leading-7">{{ run.output }}</pre></div>
        <div v-if="run.sources?.length" class="card"><h3 class="mb-2 text-xs font-semibold">Observed sources</h3><a v-for="url in run.sources" :key="url" :href="url" target="_blank" rel="noopener noreferrer" class="mb-2 block break-all text-xs text-emerald-700 underline">{{ url }}</a></div>
        <details v-if="run.notes" class="card"><summary class="text-xs">Working notes</summary><pre class="mt-3 whitespace-pre-wrap break-words text-xs leading-6">{{ run.notes }}</pre></details>
        <button v-if="run.extracted" class="btn text-xs" @click="exportText(run.extracted, 'workbrowser-extracted.txt')">Save extracted page text ↓</button>
      </section>
      </template>
    </main>
    <footer v-if="view === 'chat'" class="shrink-0 border-t bg-white p-3">
      <p class="mb-1 truncate text-[11px] text-slate-400" :title="tab?.title">{{ tab?.title ?? 'Open a browser tab to begin.' }}</p>
      <section v-if="approval" aria-labelledby="approval-title" role="region" class="max-h-[55dvh] space-y-3 overflow-y-auto rounded-xl border border-amber-200 bg-amber-50 p-3">
        <div class="flex items-center justify-between gap-2"><h2 id="approval-title" class="text-sm font-semibold">Approval needed</h2><button class="text-xs text-slate-500" @click="stop">Stop task</button></div>
        <div class="space-y-1 break-words text-xs leading-5"><p class="font-medium">{{ approval.action }} {{ approval.target }}</p><p class="break-all text-slate-500">{{ approval.origin }}</p><p v-if="approval.frameHost" class="text-slate-500">Embedded site: {{ approval.frameHost }}</p><p v-if="approval.destinationHost" class="text-slate-500">Destination: {{ approval.destinationHost }}</p><p v-if="approval.intent">{{ approval.intent }}</p></div>
        <details class="text-xs leading-5 text-slate-500"><summary class="cursor-pointer">Why approval is needed</summary><p>{{ approval.reason }}</p></details>
        <div class="flex flex-wrap gap-2">
          <button data-approval-answer="approve" class="btn-primary px-3 py-2 text-xs" :disabled="answeringApproval" @click="answerApproval('approve')">Approve once</button>
          <button v-if="approval.canRemember" data-approval-answer="approve-remember" class="btn px-3 py-2 text-xs" :disabled="answeringApproval" @click="answerApproval('approve-remember')">Always allow on this site</button>
          <button data-approval-answer="decline" class="btn px-3 py-2 text-xs" :disabled="answeringApproval" @click="answerApproval('decline')">Decline</button>
        </div>
      </section>
      <form v-else class="flex items-end gap-2 rounded-2xl border bg-slate-50 p-2" @submit.prevent="start">
        <label for="prompt" class="sr-only">Task instructions</label>
        <textarea id="prompt" ref="promptInput" v-model="prompt" rows="1" maxlength="8000" class="block max-h-36 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent p-2 text-sm leading-5" placeholder="Ask about this page…" :disabled="running || pending" @keydown.ctrl.enter.prevent="start" @keydown.meta.enter.prevent="start"></textarea>
        <button v-if="running" type="button" class="btn shrink-0 px-3 py-2 text-xs text-red-700" @click="stop">■ Stop</button>
        <button v-else class="btn-primary shrink-0 px-3 py-2 text-xs" :disabled="!prompt.trim() || pending">{{ pending ? 'Starting…' : 'Run ↑' }}</button>
      </form>
    </footer>
  </div>
</template>
