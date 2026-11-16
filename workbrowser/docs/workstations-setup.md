# Workstationsへ移して開発を再開する

最終更新: 2026-11-16。

ここでは移行先をGoogle Cloud Workstationsと想定する。会社PC上で直接Node.jsを動かす場合は [company-setup.md](company-setup.md) を使う。機能と現状は [overview.md](overview.md)、本番公開の追加作業は [cloud-migration.md](cloud-migration.md) を参照。

## 1. この手順で作る構成

```text
会社PC                                          Cloud Workstations
Chrome + Workbrowser拡張
  └─ http://localhost:8787 → 認証付きの転送 → Node.js開発サーバー
                                                   └─ Vertex AI / Gemini
```

この段階はローカル開発モードを使い、Cloud RunやIAPの本番対応を先に完成させる必要はない。「ローカル」はアプリの開発モード名であり、サーバープロセスはWorkstations上で動いていてよい。ブラウザ操作は会社PCの拡張内で行う。

ただし拡張の接続先は現在 `localhost`、`127.0.0.1`、`[::1]` のみ。会社PCのlocalhostへ転送する経路が必要。WorkstationsのHTTPSプレビューURLを直接Server URLへ入力すると、現状は拒否される。

## 2. 移行先で確認する情報

| 情報・条件 | 用途 |
| --- | --- |
| Workstationsのproject、region、cluster、config、workstation名 | 開発環境へのアクセスとTCPトンネル |
| Vertex AIのproject、location、モデルID | 会社が利用を認めるモデルへの接続 |
| サーバー用のGoogle認証とモデル利用権限 | 開発者のADC、または承認済みの実行用サービスアカウント |
| Chromeの拡張読み込み・debugger権限の可否 | 会社PC上での実拡張の確認 |
| 会社PCからlocalhostへ転送する方法 | ローカルVS Codeのポート転送、またはgcloud TCPトンネル等 |
| 調査するサイトとAIへ送ってよいサイト | 2種類の許可リスト |

WorkstationsとVertex AIのプロジェクト・リージョンが同じとは限らない。会社の構成に合わせて別々に確認する。

## 3. ソースの配置と依存関係

`workbrowser/` のソース、`pnpm-lock.yaml`、`.env.example`、ドキュメントを移す。移行用の `artifacts/workbrowser-company.zip` があれば展開して使える。`node_modules`、`.env`、`.data`、別環境のGoogle認証情報は引き継がず、移行先で用意する。ZIPにもこれらは含めない。

ソースはWorkstationsの停止・再作成後にも残る、会社指定の永続領域やGitリポジトリで管理する。Workstations内の `workbrowser/` で実行する:

```bash
node --version
gcloud --version
corepack pnpm --version
corepack pnpm install --frozen-lockfile
```

Node.jsは22.19以降。pnpmは `package.json` の `packageManager` 指定版をCorepack経由で使う。Corepackが環境にない場合は会社で認められた方法で導入する。

## 4. Workstations側でモデル接続を設定する

初回だけ `.env.example` を `.env` へコピーする:

```bash
cp .env.example .env
```

```dotenv
AI_PROVIDER=vertex
AI_MODEL=YOUR_AVAILABLE_GEMINI_MODEL_ID
GOOGLE_CLOUD_PROJECT=YOUR_VERTEX_PROJECT_ID
GOOGLE_CLOUD_LOCATION=YOUR_APPROVED_MODEL_LOCATION
VERTEX_AUTH=gcloud
HOST=0.0.0.0
PORT=8787
LOCAL_EMAIL=your.name@company.example
LOCAL_ROLE=admin
```

`YOUR_...` とメールアドレスを実際の値へ置き換える。モデルは会社のプロジェクト・リージョンで利用でき、関数呼び出しに対応するものを選ぶ。特定のモデルが会社環境で使えることは、このリポジトリでは確認していない。

`HOST=0.0.0.0` はWorkstationsのコンテナへ外部から転送する場合の設定例。会社のアクセス制限と認証付き転送の範囲で使う。転送がコンテナ内のloopbackへ到達する方式なら `127.0.0.1` を使える。会社PC上で直接動かす標準値も `127.0.0.1`。

開発者の認証を使う場合、**サーバーを実行するWorkstations内**で認証する:

```bash
gcloud auth login --no-launch-browser
gcloud auth application-default login --no-launch-browser
corepack pnpm ai:check
```

表示される認証手順に従う。CLIのログインとADCは別で、会社PCのChromeでGoogleへログインしただけではサーバーの認証は設定されない。`ai:check` のPASSでモデルへの認証と関数呼び出しを確認する。[Workstationsの認証に関する公式資料](https://docs.cloud.google.com/workstations/docs/authentication) を参照。

会社の方針で開発にもWorkstationsへ割り当てたサービスアカウントを使う場合は、`VERTEX_AUTH=metadata` の経路がある。対象アカウント、スコープ、モデル権限、metadataへの到達性を会社の構成で確認し、同じく `ai:check` で実証する。現在のアダプターはADCライブラリの自動探索ではなく、gcloudとmetadataの経路を明示的に切り替える実装。

## 5. 検査・ビルド・開発サーバー起動

Workstations内で実行する:

```bash
corepack pnpm check
corepack pnpm server
```

別のWorkstations内ターミナルで確認する:

```bash
curl --fail --silent --show-error http://localhost:8787/healthz
```

`ok: true` と `mode: local` を含むJSONが返ることを確認する。これはサーバーの生存確認であり、Gemini認証や拡張接続の確認ではない。

## 6. 会社PCのlocalhostへ転送する

会社PC上のVS Code等からWorkstationsへ接続し、8787を会社PCのlocalhost:8787へ転送できる場合は、その認証済み経路を使う。ブラウザ内エディターからプレビューを開くだけでは、会社PCのlocalhostへの転送にはならない。

会社PCでGoogle Cloud CLIを使える場合のTCPトンネル例:

```bash
gcloud workstations start-tcp-tunnel WORKSTATION_NAME 8787 \
  --project=WORKSTATIONS_PROJECT_ID \
  --region=WORKSTATIONS_REGION \
  --cluster=WORKSTATION_CLUSTER \
  --config=WORKSTATION_CONFIG \
  --local-host-port=localhost:8787
```

このコマンドは **Workstations内ではなく、Chromeが動く会社PC側**で実行し、接続中はターミナルを維持する。会社PC側のgcloudにもWorkstationsへアクセスする利用者の認証と権限が必要。8787が会社の設定で許可され、ほかのプロセスが使用していないことも確認する。[TCPトンネルの公式リファレンス](https://docs.cloud.google.com/sdk/gcloud/reference/workstations/start-tcp-tunnel) を参照。

会社PCのChromeで `http://localhost:8787/healthz` を開き、同じ生存確認が返ることを確認する。ChromeOSのLinux環境等で転送する場合も、最後にChrome本体からの到達性を確認する。

会社PCでCLIやローカル転送を使えない場合、この接続方式では実拡張を確認できない。WorkstationsのHTTPSエンドポイントへ直接接続する開発方式を追加するなら、接続先制限、Workstations認証、Cookie・リダイレクト・CORSをまとめて扱う必要がある。URL制限を外すだけでは完了しない。これは本番用IAPとは別の作業。[WorkstationsのHTTPアクセスの公式資料](https://docs.cloud.google.com/workstations/docs/access-http-servers-running-on-workstations) を参照。

## 7. 会社PCのChromeへ拡張を読み込む

1. Workstationsで生成した `workbrowser/dist/` 一式を会社PCへダウンロード・展開する。
2. 会社PCのChromeで `chrome://extensions` を開く。
3. デベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」で会社PC側の `dist/` を選ぶ。
4. 必要に応じてツールバーへピン留めする。

指定するのはChromeが動くPCから読めるフォルダー。ブラウザ内エディターに表示されたWorkstations内のパスを、そのままローカルChromeへ指定することはできない。ビルドし直した場合はPC側のファイルも更新し、拡張を再読み込みする。

## 8. 拡張の接続とサイト許可

SettingsでServer URLを `http://localhost:8787`、Local connection tokenを **Workstations側**の `.data/dev-token` の値に設定する。`Connect & save`、`Test AI connection` を順に確認する。トークンはエディターで確認して入力し、リポジトリや共有ログへ貼らない。

| 認証 | 区間 | 設定する場所 |
| --- | --- | --- |
| Workstationsへのアクセス認証 | 会社PC → Workstationsのトンネル | 会社PC側の接続ツール |
| 開発用接続トークン | 拡張 → Workbrowser開発API | 拡張のSettings |
| Google CloudのADC等 | サーバー → Gemini | Workstations側 |

続いてSites & limitsで、対象サイトの正確なオリジンを `Allowed browsing sites` と `Sites approved for AI page access` の両方へ登録する。AI送信許可の初期値は空。詳細は [company-setup.md](company-setup.md) を参照。

## 9. 動作確認と移行の完了条件

会社が承認した非機密のHTMLページで確認する:

- [ ] 現在ページの要約で、実際の内容に沿う回答と参照元が表示される。
- [ ] URLを指定し、関連ページをたどる調査ができる。
- [ ] 英語・日本語など、必要な言語で指示と回答ができる。
- [ ] Stopで後続操作が止まる。
- [ ] 未許可サイトの取得・AI送信が止まる。
- [ ] 履歴、回答、取得テキストの保存が確認できる。

Chrome for Testingを実行できる環境には、テストページと模擬モデルによる実拡張テストがある:

```bash
CHROME_PATH=/path/to/chrome corepack pnpm test:agent-browser
```

これはコマンド実行環境内のChromeを起動する。Workstations内で実行しても会社PC側のChromeを検証するものではなく、実Geminiの判断精度も確認しない。

確認したモデル・リージョン・Chrome・転送方式・結果を [validation.md](validation.md) に追記する。会社環境で実際に確認したところを開発移行の完了とし、本番公開は別途 [cloud-migration.md](cloud-migration.md) の完了条件で判断する。

## 10. よくある問題

| 症状 | 確認箇所 |
| --- | --- |
| Workstations内ではhealthzが返り、会社PCでは開かない | 転送を会社PC側で実行しているか、8787、HOST、会社のポート制限 |
| HTTPSプレビューは開くが拡張は接続できない | 拡張の接続先はloopbackのみ。localhost転送を確認 |
| `This version connects to a local server only.` | Workstationsの外部URLをServer URLに入れていないか |
| 接続APIが401 | Workstations側のdev-tokenと拡張の値の一致 |
| `AI setup required` / `AI is not configured` | サーバーの.envと再起動、ai:check。UI表示だけで認証成否を断定しない |
| Vertex認証に失敗する | Workstations内のADC、またはmetadata経路と実行主体 |
| `MODEL_DATA_DENIED` | 操作許可とAI送信許可の両方。過去の参照元の取消しも対象 |

ここにあるコマンドは移行先で実行するための手順。この資料作成時点では会社のWorkstationsへ接続して確認していない。
