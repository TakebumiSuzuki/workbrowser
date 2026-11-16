import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createApp } from './app';
import { PolicyStore } from './store';
import { createModel } from './model';

if (existsSync('.env')) loadEnvFile('.env');

// This entrypoint is intentionally local-only until shared storage and extension IAP login are integrated.
if (process.env.K_SERVICE || (process.env.AUTH_MODE && process.env.AUTH_MODE !== 'local')) {
  throw new Error('この開発版はローカル専用です。Cloud Runへの公開前に docs/cloud-migration.md の項目を実装してください。');
}
const directory = resolve(process.env.DATA_DIR ?? '.data');
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenPath = join(directory, 'dev-token');
let token: string;
try { token = (await readFile(tokenPath, 'utf8')).trim(); }
catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  token = randomBytes(32).toString('hex');
  await writeFile(tokenPath, token, { mode: 0o600 });
}
if (token.length < 32) throw new Error('ローカルトークンが短すぎます。.data/dev-token を再生成してください。');
const port = Number(process.env.PORT ?? 8787);
const model = createModel();
const app = createApp({ mode: 'local', token, localEmail: process.env.LOCAL_EMAIL ?? 'developer@example.test', localAdmin: process.env.LOCAL_ROLE !== 'user' }, new PolicyStore(directory), model);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' });
console.info(`Workbrowser local server: http://localhost:${port}`);
console.info(`AI: ${model.info.configured ? `${model.info.provider} / ${model.info.model}` : 'not configured (see docs/company-setup.md)'}`);
console.info(`接続トークンの保存先: ${tokenPath}（拡張の設定画面に貼り付けてください）`);
