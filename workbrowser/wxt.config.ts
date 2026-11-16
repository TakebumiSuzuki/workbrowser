import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  imports: false,
  outDir: 'dist',
  outDirTemplate: '',
  manifest: {
    name: 'Workbrowser',
    description: 'Autonomous browser research, information extraction and summaries. Multilingual instructions and answers.',
    minimum_chrome_version: '125',
    permissions: ['debugger', 'tabs', 'sidePanel', 'storage', 'webNavigation', 'alarms'],
    host_permissions: ['http://*/*', 'https://*/*'],
    side_panel: { default_path: 'sidepanel.html' },
    action: { default_title: 'Open Workbrowser' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: { alias: { '@puppeteer/browsers': resolve('src/browser-control/host/puppeteer-browsers-stub.ts') } },
  }),
});
