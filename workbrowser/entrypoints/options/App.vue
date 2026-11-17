<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { send, errorMessage } from '../../src/ui/bridge';
import { getExecutionMode, setExecutionMode, type ExecutionMode } from '../../src/ui/preferences';
import { DEFAULT_CONNECTION, PolicySchema, type AppState, type Identity, type Policy } from '../../src/shared/contracts';
import type { AgentInfo } from '../../src/shared/agent';
const connection = ref({ ...DEFAULT_CONNECTION });
const identity = ref<Identity>();
const info = ref<AgentInfo>();
const mode = ref<ExecutionMode>('agent');
const policy = ref<Policy>();
const origins = ref('');
const modelOrigins = ref('');
const overrides = ref('');
const section = ref('connection');
const error = ref('');
const notice = ref('');
const pending = ref(false);
const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
async function loadPolicy() {
  policy.value = await send<Policy>({ type: 'policy' });
  origins.value = policy.value.allowedOrigins.join('\n');
  modelOrigins.value = policy.value.modelOrigins.join('\n');
  overrides.value = policy.value.overrides.map(o => `${o.user}, ${o.expiresAt}`).join('\n');
  info.value = await send<AgentInfo>({ type: 'agent-info' });
}
async function connect() {
  pending.value = true; error.value = ''; notice.value = '';
  try { identity.value = await send<Identity>({ type: 'connect', ...connection.value }); await loadPolicy(); notice.value = 'Connected.'; }
  catch (e) { error.value = errorMessage(e); } finally { pending.value = false; }
}
async function testModel() {
  pending.value = true; error.value = ''; notice.value = '';
  try {
    const result = await send<AgentInfo & { ok: boolean }>({ type: 'test-model' }); info.value = result;
    if (!result.ok) throw new Error('The model did not return the expected function call.');
    notice.value = 'AI connection and function calling verified.';
  } catch (e) { error.value = errorMessage(e); } finally { pending.value = false; }
}
async function savePolicy() {
  if (!policy.value) return;
  pending.value = true; error.value = ''; notice.value = '';
  try {
    const value = PolicySchema.parse({ ...policy.value, allowedOrigins: lines(origins.value), modelOrigins: lines(modelOrigins.value), overrides: lines(overrides.value).map(s => { const [user, expiresAt] = s.split(',').map(v => v.trim()); return { user, expiresAt }; }) });
    await send({ type: 'save-policy', policy: value }); await loadPolicy(); notice.value = 'Saved. Changes apply before the next operation.';
  } catch (e) { error.value = errorMessage(e); } finally { pending.value = false; }
}
async function clearHistory() { try { await send({ type: 'clear-history' }); notice.value = 'Local history and results deleted.'; } catch (e) { error.value = errorMessage(e); } }
async function saveMode() {
  pending.value = true; error.value = ''; notice.value = '';
  try { await setExecutionMode(mode.value); notice.value = 'Execution mode saved. Applies to new tasks.'; }
  catch (e) { error.value = errorMessage(e); }
  finally { pending.value = false; }
}
function openDemo() { void chrome.tabs.create({ url: connection.value.serverUrl + '/demo' }); }
onMounted(async () => {
  try {
    const [state, preferredMode] = await Promise.all([send<AppState>({ type: 'state' }), getExecutionMode()]);
    connection.value = state.connection; mode.value = preferredMode;
    if (connection.value.token) { identity.value = await send<Identity>({ type: 'identity' }); await loadPolicy(); }
  } catch (e) { error.value = errorMessage(e); }
});
</script>
<template>
  <div class="mx-auto max-w-5xl px-6 py-10">
    <header class="mb-10 flex items-center gap-3"><span class="flex size-10 items-center justify-center rounded-xl bg-emerald-800 text-xl font-bold text-white">w.</span><div><h1 class="text-lg font-semibold">Workbrowser</h1><p class="text-xs text-slate-400">Settings</p></div></header>
    <div class="grid gap-8 md:grid-cols-[190px_1fr]">
      <nav class="space-y-1"><button v-for="item in [{id:'connection',label:'Connection & AI'},{id:'policy',label:'Sites & permissions'},{id:'data',label:'Data & history'}]" :key="item.id" class="block w-full rounded-xl px-4 py-3 text-left text-sm" :class="section === item.id ? 'bg-emerald-50 font-medium text-emerald-900' : 'text-slate-500'" @click="section = item.id; notice = ''; error = ''">{{ item.label }}</button><div v-if="identity" class="mt-6 border-t px-4 pt-4"><p class="break-all text-xs text-slate-500">{{ identity.email }}</p><p class="mt-1 text-[10px] text-emerald-700">{{ identity.admin ? 'Local administrator' : 'User' }}</p></div></nav>
      <main>
        <p v-if="error" role="alert" class="mb-5 rounded-xl bg-red-50 p-4 text-sm leading-6 text-red-800">{{ error }}</p><p v-if="notice" role="status" class="mb-5 rounded-xl bg-emerald-50 p-4 text-sm leading-6">{{ notice }}</p>
        <section v-if="section === 'connection'" class="space-y-5">
          <h2 class="text-2xl font-semibold">Connect to Workbrowser</h2>
          <p class="text-sm leading-7 text-slate-500">Run the server on this computer (or in your forwarded dev container). Configure its AI provider, then connect the extension below.</p>
          <div class="card space-y-3"><label class="block text-xs font-medium">Execution mode<select v-model="mode" class="mt-2 block w-full" :disabled="pending" @change="saveMode"><option value="agent">AI agent</option><option value="mock">Offline demo</option></select></label><p class="text-xs leading-6 text-slate-500">Applies to new tasks. Offline demo uses fixed commands without AI.</p></div>
          <form class="card space-y-5" @submit.prevent="connect"><label class="block text-xs font-medium">Server URL<input v-model="connection.serverUrl" class="mt-2 block w-full" type="url" required placeholder="http://localhost:8787"></label><label class="block text-xs font-medium">Local connection token<input v-model="connection.token" class="mt-2 block w-full font-mono" type="password" required autocomplete="off"></label><p class="text-xs leading-6 text-slate-400">Copy the value from .data/dev-token on the server computer. AI credentials are stored only on the server.</p><button class="btn-primary" :disabled="pending">{{ pending ? 'Connecting…' : 'Connect & save' }}</button></form>
          <div v-if="identity" class="card space-y-4"><h3 class="font-medium">AI connection</h3><p class="break-all text-xs">{{ info?.configured ? `${info.provider} / ${info.model}` : 'Not configured. See docs/company-setup.md in this project.' }}</p><p class="text-xs leading-6 text-slate-500">Set AI_PROVIDER, AI_MODEL and Google Cloud settings in the server .env, then restart the server. This test makes one model request without page content.</p><button class="btn" :disabled="pending || !info?.configured" @click="testModel">Test AI connection</button></div>
          <div class="card flex justify-between gap-4"><p class="text-sm">Demo CRM with 100 sample customers</p><button class="btn text-xs" :disabled="!identity" @click="openDemo">Open demo ↗</button></div>
        </section>
        <section v-if="section === 'policy'" class="space-y-5">
          <h2 class="text-2xl font-semibold">Sites, permissions & limits</h2><p v-if="!policy" class="card">Connect to the server first.</p>
          <form v-else class="card space-y-6" @submit.prevent="savePolicy"><p v-if="!identity?.admin" class="text-xs">Only administrators can change these settings.</p>
            <label class="block text-xs font-medium">Allowed browsing sites — one origin per line<textarea v-model="origins" rows="5" class="mt-2 block w-full font-mono text-xs" :disabled="!identity?.admin" placeholder="https://crm.example.com"></textarea><span class="mt-2 block text-xs font-normal leading-6 text-slate-400">Exact HTTP(S) origins, without paths. Specify subdomains and ports separately. Empty means deny all.</span></label>
            <label class="block text-xs font-medium">Sites approved for AI page access — one origin per line<textarea v-model="modelOrigins" rows="5" class="mt-2 block w-full font-mono text-xs" :disabled="!identity?.admin" placeholder="https://crm.example.com"></textarea><span class="mt-2 block text-xs font-normal leading-6 text-slate-400">The AI agent uses sites approved in both lists. Page text, element labels and URLs from these sites may be sent to the configured AI. Visual fallback may send masked, labelled screenshots. Empty disables page access by AI.</span></label>
            <fieldset class="space-y-4 border-t pt-5">
              <legend class="text-sm font-semibold">Action permissions</legend>
              <label class="block text-xs font-medium">Default approval mode<select v-model="policy.writeMode" aria-label="Default approval mode" class="mt-2 block w-full" :disabled="!identity?.admin"><option value="ask">Ask — confirm submissions and deletions</option><option value="auto">Auto — run requested actions</option></select></label>
              <p class="text-xs leading-6 text-slate-500">Site rules override this mode. Allow runs requested actions, Ask confirms each detected submission or deletion, and Block prevents them. These rules do not grant browsing or AI access. Payments, account access grants and secret input still require manual action.</p>
              <div v-for="(item, index) in policy.writeRules" :key="index" class="flex flex-wrap items-center gap-2">
                <input v-model="item.origin" class="min-w-0 flex-1" type="url" required placeholder="https://crm.example.com" :aria-label="`Action rule site ${index + 1}`" :disabled="!identity?.admin">
                <select v-model="item.rule" :aria-label="`Action rule ${index + 1}`" :disabled="!identity?.admin"><option value="allow">Allow</option><option value="ask">Ask</option><option value="block">Block</option></select>
                <button type="button" class="rounded-lg p-2 text-slate-500" :aria-label="`Remove action rule ${index + 1}`" :disabled="!identity?.admin" @click="policy.writeRules.splice(index, 1)">×</button>
              </div>
              <button type="button" class="btn text-xs" :disabled="!identity?.admin || policy.writeRules.length >= 200" @click="policy.writeRules.push({origin:'',rule:'ask'})">Add site rule</button>
            </fieldset>
            <label class="block text-xs font-medium">Temporary per-user browsing override<textarea v-model="overrides" rows="2" class="mt-2 block w-full font-mono text-xs" :disabled="!identity?.admin" placeholder="user@example.com, 2026-12-01T18:00:00.000Z"></textarea><span class="mt-2 block text-xs font-normal leading-6 text-slate-400">email, expiry (UTC). Maximum 24 hours. Does not override AI page access restrictions.</span></label>
            <div class="grid grid-cols-2 gap-4"><label class="text-xs">Maximum agent turns / demo steps<input v-model.number="policy.maxSteps" class="mt-2 block w-full" type="number" min="1" max="500" :disabled="!identity?.admin"></label><label class="text-xs">Maximum minutes<input v-model.number="policy.maxMinutes" class="mt-2 block w-full" type="number" min="1" max="60" :disabled="!identity?.admin"></label></div><button v-if="identity?.admin" class="btn-primary" :disabled="pending">Save settings</button>
          </form>
        </section>
        <section v-if="section === 'data'" class="space-y-5"><h2 class="text-2xl font-semibold">Data & history</h2><div class="card space-y-4 text-sm leading-7"><p>The latest 20 tasks are saved locally, including instructions, activity, answers, notes and extracted text. Earlier turns in the current conversation are sent with follow-up questions. Extracted text is capped at 200,000 characters per run and can be downloaded.</p><p>AI mode sends your instruction, URLs, approved page text and working context through the local server to the configured model. Visual fallback also sends masked, labelled viewport screenshots to an image-capable model. Screenshot bytes are not saved in history. Page input secrets are masked by the browser layer; avoid including secrets in your own instructions. Offline demo mode makes no model calls.</p><button class="btn text-xs text-red-700" @click="clearHistory">Delete local history & results</button></div><div class="card text-xs leading-6 text-slate-500">Browser control is derived from Nanobrowser (Apache-2.0). <a class="underline" href="NANOBROWSER-LICENSE.txt" target="_blank" rel="noopener">License</a></div></section>
      </main>
    </div>
  </div>
</template>
