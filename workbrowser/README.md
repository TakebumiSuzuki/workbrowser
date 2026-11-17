# Workbrowser

日本語の資料は **[ドキュメント一覧](docs/README.md)** から参照してください。[概要・基本仕様](docs/overview.md)、[Workstationsへの開発環境移行](docs/workstations-setup.md)、[本番のIAP・Cloud Run対応](docs/cloud-migration.md) をまとめています。

Chrome extension for browser conversations, research and user-requested actions. Give an instruction in English, Japanese, or another language supported by the configured model. Start from the current page or provide a URL; the agent observes pages, chooses tools, researches or performs the requested actions according to your permission settings, and returns an answer.

The UI is in English. Instructions and answers can use any language supported by the configured model; no language selection is needed.

## Company computer setup

See **[会社PCでの導入手順](docs/company-setup.md)**, or **[Workstationsでの開発手順](docs/workstations-setup.md)** when the server runs remotely. The extension and a local development server are both required. Configure the company's Vertex AI project, region and actual Gemini model ID in the server `.env`, authenticate the server, approve target sites in Settings, then use the extension. No AI credentials are embedded in the extension.

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env, then authenticate on the server computer:
gcloud auth application-default login
corepack pnpm ai:check
corepack pnpm build
corepack pnpm server
```

Load `workbrowser/dist` as an unpacked extension in Chrome. Connect to `http://localhost:8787` using the value in `.data/dev-token`. In a Dev Container, forward port 8787 privately to the computer running Chrome.

In Settings → Sites & permissions, add target origins to **both** the browsing list and the AI page access list. Origins match exactly, including protocol, subdomain and port. AI page access defaults to empty. Only approve company-authorized sites for the chosen AI provider.

## What is implemented

- A model-driven observe → act → result loop, based on Nanobrowser's single-agent design; fixed commands are not used in AI mode.
- Current-page reading, extraction and summaries, plus URL navigation, linked pages, search inputs, pagination, scrolling and waits.
- Native Gemini function calling over Vertex AI REST; optional Gemini Developer API when company policy permits.
- Native function call IDs and opaque thought signatures preserved across turns. One browser call runs per model response; further calls get matching skipped results to avoid stale batches.
- Working notes retained across long tasks; old observations can be elided after notes exist. Context and tool results are bounded and truncation is visible.
- Recovery from safe pre-dispatch errors using the next model decision. Unknown delivery, unverified effects and detected protected operations stop execution rather than repeating an uncertain action.
- Repeated/no-effect call detection, turn/time limits, stop, partial results and explicit final answers.
- Server-side and extension-side site checks before model requests and browser operations. Previously captured sources are rechecked after policy changes. Browsing overrides never override AI page access approval.
- Continuing conversations: follow-up questions receive earlier instructions, answers, notes and operation evidence from the same conversation. New conversation starts fresh; History reopens a saved conversation. The latest 20 tasks are retained locally.
- Visual fallback after unresolved/ambiguous DOM targets, or when the model requests it: Nanobrowser's masked screenshots with red bounding boxes and element ref labels are sent to Gemini; actions use those refs.
- Notes, answers, observed sources and downloadable extracted text (up to 200,000 characters per run).
- Readable Activity: opened URLs, resolved button/link names, field read-back and selected-option results, and failures. Generic model-progress messages update the status instead of filling the activity list. The raw operation log is nested inside Activity.
- English UI; multilingual instructions and answers without a language selector.
- AI connection diagnosis in Settings and `pnpm ai:check`.
- Action permissions: Ask/Auto defaults, exact-origin Allow/Ask/Block rules, and an approval card for detected submissions/deletions. Approve once, decline, or persist Allow for a site when permitted. The model cannot answer its own approval request.

Example instructions:

```text
Summarize this page and highlight the key risks.
Extract the names, dates and amounts on this page into a table.
Go to https://example.com, find its pricing pages and compare the plans. Include source URLs.
このページから会社名と所在地を取り出して、表にまとめて。
関連ページも確認して、サービスの違いを日本語で要約して。
Résume cette page en français et cite les sources.
```

## Data and operational scope

AI mode sends the instruction, retained turns of the current conversation, approved page text/element labels, URLs (including query strings where relevant), tool results and working notes through the local server to the configured AI. Visual fallback also sends masked, labelled viewport screenshots and requires an image-capable Gemini model. Page text and images are untrusted data. Arbitrary page scripts are unavailable. The layer masks known secrets/password/payment/OTP fields and excluded frames; this is not a general personal-data classification system. Do not put secrets in prompts. Screenshot bytes are not saved in local history.

One task operates in the selected tab. Avoid manually changing that tab during a run. If a link opens another tab, the agent can use its reported URL in the selected tab; it cannot choose arbitrary existing tabs. Login/CAPTCHA, secret input, payments and account access grants require manual intervention. Detected submissions/deletions follow the configured action permissions; search/navigation are allowed. Detection is best effort and cannot catch every automatic save or custom control. PDFs, Office files and images do not have a dedicated parser in this version.

In **Settings → Sites & permissions → Action permissions**, **Ask** (the default) asks before detected submissions/deletions; **Auto** executes requested actions without that extra approval. A site's **Allow**, **Ask**, or **Block** rule takes precedence over the default. These rules never grant browsing or AI page access. Site settings require administrator rights. **Always allow on this site** is available to administrators unless the site explicitly requires Ask. Approvals are bound to one pending action/run, and targets and permissions are checked again before execution. Stop, timeout or worker restart withdraws a pending request; an old answer cannot resume it. Ordinary conversation and reflection do not need browser-action evidence or another observation of the current page.

The Gemini `generateContent` API used here is stateless. Each request includes the conversation history and exactly one `systemInstruction`; the fixed prompt is never accumulated in conversation history. Sending it only on the first HTTP request would omit it from later requests. See the [Google function-calling guide](https://ai.google.dev/gemini-api/docs/generate-content/function-calling).

Stop prevents subsequent actions; already sent input cannot be undone. Worker restart marks a running task interrupted. There is no automatic replay or automatic resume. Each task uses fresh browser refs and the current page, and receives the saved earlier turns in its conversation. Use the **＋ New conversation** button to start without earlier turns. History can reopen another saved conversation. Readable Activity retains up to 500 entries or 96,000 UTF-8 bytes per task; the raw operation log retains up to 24,000 characters. Omitted content is marked. Older history keeps its original recorded data; missing action details cannot be reconstructed. Offline demo tasks stay separate from AI conversations.

The server entrypoint accepts local connections only. **Workspace/IAP extension login and a shared Cloud Run service are not deployment-ready.** Running this version on a company computer with a local server is supported by the setup instructions; organization-wide deployment still requires the work in [cloud-migration.md](docs/cloud-migration.md).

## Offline demo

When no model is configured, AI mode reports that setup is required; it never silently switches to a mock. Select **Offline demo** under **Settings → Connection & AI → Execution mode** to use the older deterministic simulator without external AI calls. The selection is saved locally and applies to new tasks. Open the demo CRM from Settings and use:

```text
ページのテキストを取得
「検索」に「顧客 001」を入力
「検索する」をクリック
100件を順番に処理
```

These are demo commands, not the language parser for AI mode. The 100-record update exercise is available only in this explicit demo mode.

## Development and verification

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Unit/integration tests exercise the real agent loop, API validation and Gemini HTTP encoding with scripted model responses and simulated browser results. They do not prove real model reasoning or real browser behavior.

On a computer that can run Chrome for Testing / Chromium:

```bash
CHROME_PATH=/path/to/chrome corepack pnpm test:agent-browser
CHROME_PATH=/path/to/chrome corepack pnpm test:browser
CHROME_PATH=/path/to/chrome corepack pnpm test:conversation-vision
CHROME_PATH=/path/to/chrome corepack pnpm test:permissions
CHROME_PATH=/path/to/chrome corepack pnpm test:activity
```

The first loads the actual extension and checks URL navigation, linked-page reading, current-page summary and multilingual answer plumbing using a scripted model. The second covers the legacy offline demo. The third checks DOM failure → masked/labelled image → ref-based click, conversational follow-ups, reload, fresh conversations and History. The fourth checks the real Settings and approval UI, approve/decline, remembered rules, Auto/Ask/Block, policy changes, Stop, stale answers and target revalidation. The fifth opens Activity and checks real destinations, clicked controls, input/selection results, errors, links and persistence after reload. These use a temporary profile/server and `--use-mock-keychain`. Real AI reasoning and the company model configuration require separate verification; see [validation.md](docs/validation.md).

## Structure and attribution

```text
src/agent/             Model/tool loop, prompt, working context and tool definitions
src/extension/         Chrome wiring, stop, persistence and server access
src/shared/            Validated API contracts and policy
src/browser-control/   Nanobrowser-derived CDP/Puppeteer browser layer
entrypoints/           Vue side panel, settings and extension background
server/                Local authenticated API, Vertex/Gemini adapter, policy store and demo
scripts/               AI connection test and real-extension smoke checks
```

The browser layer is derived from the supplied Nanobrowser clone under Apache-2.0. Its single-agent loop, tool catalogue wrapper, prompt and guard design were consulted for the Workbrowser agent implementation; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
