<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { send, errorMessage } from '../../src/ui/bridge';
import type { AgentInfo } from '../../src/shared/agent';
import type { AppState, Run } from '../../src/shared/contracts';
const state = ref<AppState>();
const info = ref<AgentInfo>();
const prompt = ref('');
const mode = ref<'agent' | 'mock'>('agent');
const error = ref('');
const pending = ref(false);
const tab = ref<chrome.tabs.Tab>();
const view = ref<'chat' | 'history'>('chat');
const selected = ref<Run>();
const run = computed(() => selected.value ?? state.value?.run);
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
    state.value = await send<AppState>({ type: 'state' });
    tab.value = state.value.run?.status === 'running'
      ? await chrome.tabs.get(state.value.run.tabId).catch(() => undefined)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  } catch (e) { error.value = errorMessage(e); }
}
async function start() {
  if (running.value || pending.value || !tab.value?.id || !prompt.value.trim()) return;
  error.value = ''; pending.value = true; selected.value = undefined;
  try { await send({ type: 'start', prompt: prompt.value, tabId: tab.value.id, mode: mode.value }); prompt.value = ''; await refresh(); }
  catch (e) { error.value = errorMessage(e); }
  finally { pending.value = false; }
}
async function stop() { try { await send({ type: 'stop' }); } catch (e) { error.value = errorMessage(e); } }
function settings() { void chrome.runtime.openOptionsPage(); }
function storageChanged() { void refresh(); }
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  void refresh();
  try { info.value = await send<AgentInfo>({ type: 'agent-info' }); } catch { /* Setup is shown below. */ }
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
    <header class="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
      <div class="flex items-center gap-3"><span class="flex size-9 items-center justify-center rounded-xl bg-emerald-800 text-lg font-bold text-white">w.</span><div><h1 class="font-semibold">Workbrowser</h1><p class="text-[10px] text-slate-400">Research, extract, summarize.</p></div></div>
      <div class="flex items-center gap-2"><button class="rounded-lg p-2" aria-label="Settings" @click="settings">⚙</button></div>
    </header>
    <div class="flex items-center justify-between gap-2 border-b bg-emerald-50 px-5 py-2 text-[11px] text-emerald-900">
      <select v-model="mode" :disabled="running || pending" aria-label="Execution mode"><option value="agent">AI agent</option><option value="mock">Offline demo</option></select>
      <span v-if="mode === 'agent'">{{ info?.configured ? `${info.provider} / ${info.model}` : 'AI setup required' }}</span><span v-else>Fixed demo commands · no AI</span>
    </div>
    <nav class="flex gap-5 border-b bg-white px-5 text-xs"><button v-for="item in [{id:'chat',label:'Task'},{id:'history',label:'History'}]" :key="item.id" class="border-b-2 py-3" :class="view === item.id ? 'border-emerald-700 font-semibold' : 'border-transparent text-slate-400'" @click="view = item.id as 'chat' | 'history'; selected = undefined">{{ item.label }}</button></nav>
    <main class="flex-1 overflow-y-auto p-5">
      <p v-if="error" role="alert" class="mb-4 rounded-xl bg-red-50 p-3 text-xs leading-6 text-red-800">{{ error }}</p>
      <template v-if="view === 'history'">
        <p class="mb-4 text-xs text-slate-400">Up to 20 runs saved in this Chrome profile.</p>
        <p v-if="!state?.history.length" class="text-sm text-slate-400">No runs yet.</p>
        <button v-for="item in state?.history" :key="item.id" class="mb-2 block w-full rounded-xl border bg-white p-4 text-left" @click="selected = item"><span class="mb-2 block truncate text-sm">{{ item.prompt }}</span><span class="text-xs text-slate-400">{{ statusLabel(item) }} · {{ item.completed }} steps</span></button>
      </template>
      <template v-if="view === 'chat' && !run">
        <div class="pt-7"><p class="eyebrow">YOUR BROWSER ASSISTANT</p><h2 class="mt-3 text-2xl font-semibold leading-relaxed">What would you like to find?</h2><p class="mt-3 text-xs leading-6 text-slate-500">Ask in English, Japanese, or another language. Work with this page, or include a URL to visit. The agent reads pages, chooses actions, and returns an answer with sources.</p></div>
        <div class="mt-7 space-y-2"><button v-for="example in examples" :key="example" class="block w-full rounded-xl border bg-white px-4 py-3 text-left text-xs leading-6 hover:border-emerald-500" @click="prompt = example">{{ example }}</button></div>
      </template>
      <section v-if="run && (view === 'chat' || selected)" class="space-y-4">
        <div class="rounded-2xl bg-emerald-800 px-4 py-3 text-sm leading-6 text-white">{{ run.prompt }}</div>
        <div class="card"><div class="flex justify-between text-xs font-semibold"><span>{{ statusLabel(run) }}</span><span>{{ run.completed }}{{ run.mode === 'mock' ? ` / ${run.total}` : '' }} steps</span></div><p class="mt-3 text-xs leading-6" aria-live="polite">{{ run.message }}</p></div>
        <details v-if="run.events.length" class="card"><summary class="cursor-pointer text-xs">Activity · {{ run.events.length }}</summary><ol class="mt-3 max-h-64 space-y-2 overflow-y-auto"><li v-for="(event, i) in run.events" :key="i" class="text-[11px]" :class="event.status === 'error' ? 'text-red-600' : 'text-slate-500'">{{ event.status === 'ok' ? '✓' : '·' }} {{ event.label }}</li></ol></details>
        <div v-if="run.output" class="card"><div class="mb-3 flex justify-between"><h3 class="text-xs font-semibold">Answer</h3><button class="text-xs text-emerald-700" @click="exportText(run.output, 'workbrowser-answer.txt')">Save ↓</button></div><pre class="whitespace-pre-wrap break-words font-sans text-sm leading-7">{{ run.output }}</pre></div>
        <div v-if="run.sources?.length" class="card"><h3 class="mb-2 text-xs font-semibold">Observed sources</h3><a v-for="url in run.sources" :key="url" :href="url" target="_blank" rel="noopener noreferrer" class="mb-2 block break-all text-xs text-emerald-700 underline">{{ url }}</a></div>
        <details v-if="run.notes" class="card"><summary class="text-xs">Working notes</summary><pre class="mt-3 whitespace-pre-wrap break-words text-xs leading-6">{{ run.notes }}</pre></details>
        <button v-if="run.extracted" class="btn text-xs" @click="exportText(run.extracted, 'workbrowser-extracted.txt')">Save extracted page text ↓</button>
      </section>
    </main>
    <footer v-if="view === 'chat'" class="border-t bg-white p-4">
      <p class="mb-3 truncate text-[11px] text-slate-400">{{ tab?.title ?? 'Open a browser tab to begin.' }}</p>
      <form class="rounded-2xl border bg-slate-50 p-2" @submit.prevent="start"><label for="prompt" class="sr-only">Task instructions</label><textarea id="prompt" v-model="prompt" rows="3" maxlength="8000" class="w-full resize-none border-0 bg-transparent p-2 text-sm" placeholder="Summarize this page, extract data, or visit a URL…" :disabled="running || pending" @keydown.ctrl.enter.prevent="start" @keydown.meta.enter.prevent="start"></textarea><div class="flex items-center justify-between px-1 pb-1"><span class="text-[10px] text-slate-400">Any instruction language</span><button v-if="running" type="button" class="btn text-xs text-red-700" @click="stop">■ Stop</button><button v-else class="btn-primary text-xs" :disabled="!prompt.trim() || pending">{{ pending ? 'Starting…' : 'Run ↑' }}</button></div></form>
    </footer>
  </div>
</template>
