# 会社PCで使い始める

資料一覧は [README.md](README.md)、アプリの概要と基本仕様は [overview.md](overview.md) を参照してください。Google Cloud Workstations上でサーバーを動かす場合は、会社PCのChromeとの接続方法が異なるため [workstations-setup.md](workstations-setup.md) を先に読んでください。本番のIAP・Cloud Run対応は [cloud-migration.md](cloud-migration.md) にまとめています。

この手順は「会社PCのChrome + 同じPC（または接続済みDev Container）のローカルサーバー」で使う構成です。Google Cloud側のプロジェクト・利用権限・モデルへのアクセスは会社環境で設定します。コードを移しただけで会社アカウントへのアクセス権が自動的に得られるわけではありません。

## 1. 持っていくもの

`workbrowser/` のソース、`pnpm-lock.yaml`、`.env.example` と、ビルドした `dist/` をコピーします。`node_modules`、`.data`、`.env` はコピーせず、会社PCで作り直します。現在のデモ履歴や接続トークン、別環境の認証情報は移しません。

必要なもの:

- Chrome 125以降。組織のポリシーでこの拡張の読み込みと `debugger` 権限が許可されていること。
- サーバー実行用のNode.js 22.19以降（Node 24推奨）、Corepack/pnpm。
- Vertex AIを利用できる会社のGoogle Cloudプロジェクト、実際に利用可能なGeminiモデルIDとリージョン。
- サーバーPCのGoogle Cloud CLI。API呼び出しに必要なIAM権限と利用枠は会社の管理者に設定してもらいます。

ChromeOSでは、許可されたLinux開発環境など、Node.jsとGoogle Cloud CLIを実行できる場所が必要です。会社の制限でローカルサーバーを実行できない場合、拡張だけでは利用できません。その場合は別途IAP対応の社内サーバー構成が必要です。この版のサーバーをそのままインターネットへ公開しないでください。

## 2. サーバーのAI接続を設定

会社PCの `workbrowser/` で:

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
```

`.env` に会社の値を入力します:

```dotenv
AI_PROVIDER=vertex
AI_MODEL=会社のプロジェクトで利用可能な実際のGeminiモデルID
GOOGLE_CLOUD_PROJECT=会社のプロジェクトID
GOOGLE_CLOUD_LOCATION=会社が承認したリージョン
VERTEX_AUTH=gcloud
HOST=127.0.0.1
PORT=8787
LOCAL_EMAIL=自分の会社メールアドレス
```

上記の日本語の値は説明用です。実際のIDに置き換えてください。`global` を選べる場合も、データ所在地の会社ルールに従います。モデルIDは固定していないため、会社が許可する関数呼び出し対応のGeminiモデルを指定できます。

```bash
gcloud auth application-default login
corepack pnpm ai:check
```

`PASS` とモデル名が表示されれば、サーバー側の認証と関数呼び出しを確認できています。この確認はページ情報を送らずにモデルへ1回問い合わせるため、API利用料が発生し得ます。コマンドはサーバーを実行する環境で行います。Dev Container内にサーバーがある場合、ホストPCのgcloudログインだけでは認証できません。

会社がGemini Developer APIを許可する場合だけ、代替として `AI_PROVIDER=gemini`、`AI_MODEL`、`GEMINI_API_KEY` をサーバーの `.env` に設定できます。APIキーを拡張に入力する必要はありません。

参考: [Google CloudのREST認証](https://docs.cloud.google.com/docs/authentication/rest)、[関数呼び出し](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/function-calling)。

## 3. 起動と拡張の読み込み

```bash
corepack pnpm build
corepack pnpm server
```

1. Dev Containerで起動する場合は、8787をPCのlocalhost:8787へPrivateでポート転送します。
2. Chromeの `chrome://extensions` でデベロッパーモードを有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」で、Chromeが動くPCから見える `workbrowser/dist` を選びます。
4. 拡張のSettingsでServer URLを `http://localhost:8787` に設定します。
5. サーバー側に生成された `.data/dev-token` の値をLocal connection tokenに貼り付け、Connect & saveを押します。
6. Test AI connectionが成功することを確認します。

`.data/dev-token` はローカルサーバーへの接続用で、Google認証トークンではありません。LOCAL_EMAIL/LOCAL_ROLEもローカル利用の表示・権限用であり、Workspace本人確認には使っていません。

## 4. 対象サイトを承認

Settings → Sites & permissionsで、例えば次の値を **Allowed browsing sitesとSites approved for AI page accessの両方** に入力して保存します:

```text
https://example.com
https://docs.example.com
```

実際の業務サイトへ置き換えます。パスは付けません。HTTP/HTTPS・サブドメイン・ポートは別扱いです。リンク先やiframeが別オリジンで、その情報も必要な場合は個別に承認します。許可サイトのページ本文・要素名・URL・取得結果は設定済みAIへ送信されます。AI送信リストは初期状態では空です。会社のデータ送信ルールに従って承認してください。

## 5. 使う

対象サイトへ通常のChromeでログインしておきます。Settings → Connection & AI → Execution modeがAI agent（初期値）であることを確認し、拡張アイコンでサイドパネルを開いて実行します。

```text
Summarize this page and list the key decisions.
Extract the company names and addresses from this page as a table.
Go to https://example.com, find the pricing pages, and compare the plans with source URLs.
このページを日本語で要約して。
関連ページも確認し、日付と金額を一覧にして。
```

指示と回答はUIの言語に縛られません。モデルが対応する言語を使えます。現在ページの要約ならURLの指定は不要です。URLを指定する場合、新規タブや許可外のページから開始しても、そのページを読まずに承認済みの移動先を開けます。

保存・送信・削除の確認方法はSettings → Sites & permissions → Action permissionsで設定します。初期値Askでは操作前に承認カードが出ます。Approve onceは今回だけの承認、Declineは拒否です。Autoまたはサイト別Allowでは依頼した操作を追加確認なしで進めます。サイト別Ask/Blockが優先します。管理者はカードのAlways allow on this siteでAllowを保存できますが、サイト別Askでは表示しません。

処理中は対象タブを手で操作しないでください。Stopは次の操作を止め、承認待ちも取り消します。ログイン・CAPTCHAなど手動対応が必要な場合はブラウザで対応後、会話を続けてください。拡張再起動後の自動再開はありません。

## 6. 会社PCでの動作確認

最初は機密情報を含まない承認済みページで、現在ページの要約、URL指定、関連リンクの取得を試します。取得内容と参照元を画面で確認してください。これは実モデルの判断と会社ネットワークを含む確認です。

Chrome for Testingを実行できる場合は、実際の拡張と操作層の接続を自動確認できます:

```bash
CHROME_PATH=/path/to/chrome corepack pnpm test:agent-browser
```

このスクリプトはローカルのテストページと模擬モデルを使い、通常のChromeプロファイルや業務サイトは使いません。

## 問題があるとき

- AI is not configured: `.env` のAI_PROVIDER/AI_MODEL等を確認し、サーバーを再起動します。
- Vertex authentication failed: サーバー環境にgcloudをインストールし、application-default loginを行います。
- AI request failed (HTTP 403/404/429): 会社プロジェクトの権限、モデルとリージョン、利用枠を確認します。
- Destination not approved / MODEL_DATA_DENIED: 操作許可とAI送信許可の両方に、移動先・参照元オリジンがあるか確認します。
- 実行中に権限が変更された: それ以前に取得したページも再評価されます。設定を確認して新しく開始します。
- PDF・画像・Office文書: この版では専用の内容解析を実装していません。HTMLページを対象にしてください。
