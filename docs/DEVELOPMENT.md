# 開発ガイド

本ドキュメントは、GitHub リポジトリ `watabegg/slidock` の開発手順と検証方法を説明する開発者向けガイドです。本リポジトリは現在開発中であり、ソースコードは公開されていますが、npm やネイティブ向けのパッケージ配布、およびライセンスの選定は完了していません。

## 前提条件と環境構築

開発には以下の環境が必要です。

- Node.js 24.22.1 以上
- pnpm 12.3.4（ロックファイルを固定して使用）

リポジトリを取得後、依存関係の解決、テスト用ブラウザの導入、パッケージのビルド、初期検証を順に実行します。

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm build:packages
pnpm check
```

Linux 環境でテスト用ブラウザやシステム依存ライブラリが不足している場合は、以下のコマンドで Chromium と必要な依存パッケージを導入してください。

```bash
pnpm exec playwright install --with-deps chromium
```

ブラウザ検証には標準で Chromium の headless チャンネルを使用します。任意の実行バイナリを使用する場合は、環境変数 `CHROMIUM_EXECUTABLE` で上書きしてください。なお、ビルド時にフォント取得などの外部通信が発生するため、インターネット接続が必要です。

## リポジトリ構成

本リポジトリは以下のコンポーネントで構成されています。個別の設計理由については [DECISIONS.md](DECISIONS.md) を参照してください。

- `apps/slive`: Rust によるコア・ホスト実装および TypeScript 製 UI
- `apps/slidock-worker`: Edge、ブラウザ、Node.js 向けスクリプト群
- `packages/slidock`: Node.js ビルドパイプライン、クライアント、フロントエンド
- `packages/protocol`: 純粋な契約（contracts）およびブリッジ定義
- `packages/slidev-adapter`: Node.js 向けの Slidev 非公開 API 境界に加え、Worker でも利用可能な Node.js 非依存のクリック操作
- `packages/slive-tools`: 準備および接続用の Node.js ツール群
- `packages/cli`: 各種機能を呼び出す薄いアダプター

## 日常の開発と品質管理

日々の変更に対する検証には `pnpm check` を使用します。内部では以下の順序で検査が実行されます。

1. `lint`（静的解析）
2. `format:check`（整形確認）
3. `typecheck`（型検査）
4. `test`（単体・結合テスト）
5. `check:boundaries`（依存境界の検査）

静的解析ツールの Oxlint は Vue テンプレート内の型整合性を保証しないため、型検査には `vue-tsc` を組み合わせて安全性を確保しています。コード整形の適用には `pnpm format` を実行してください。フォーマッターの除外対象（`**/*.md`、ロックファイル、`generated/`、`artifacts/`、`dist/`、`target/`、`results/`）の詳細は `.oxfmtrc.json` に定義されています。

アーキテクチャ境界の例外は許容されず（例外数 0）、本番コードから実験用コード（`experiments`）をインポートすることは禁止されています。不要な抽象化を避け、コードには実装方法（How）、テストには振る舞い（What）、コミットには変更理由（Why）、コメントには採用しなかった理由（Why Not）を記述してください。また、ビルド成果物や秘密情報を Git に含めてはいけません。

## ビルドと開発サーバー

コンポーネントごとのビルドおよび開発サーバー起動コマンドは以下のとおりです。

- **フレームワークのパッケージ**: `pnpm build:packages`
- **公式テーマのデモ**: `pnpm dev:slidock`（開発）/ `pnpm build:slidock` → `pnpm preview:slidock`（静的ビルドの確認）
- **共有バンドルの回帰用フィクスチャ**: `pnpm build:slidock:fixtures` → `pnpm verify:slidock:fixtures`
- **Slive**: `pnpm slive:prepare` / `pnpm build:slive-ui`
- **Workers**: `pnpm build:workers` / `pnpm dev:workers`

### localhost:4174 の実行元

`pnpm dev:slidock` → `scripts/dev-official-themes.mjs` → `@slidock/slidock` の `devHub()` という順に起動します。Node API はビルド済みの `packages/slidock/dist/node/` から読み込まれます。

| 対象 | 編集する場所 |
| --- | --- |
| デモのホーム | `examples/official-themes/App.vue`（`home.ts` からマウント） |
| 共通 Vue コンポーネントと CSS | `packages/slidock/src/frontend/` |
| デモの資料 | `examples/official-themes/slides/` |
| 資料・テーマ・ホームの指定 | `scripts/official-themes-config.mjs` |
| 開発サーバー本体 | `packages/slidock/src/node/dev.ts`、`src/node/internal/dev.mjs` |

開発時は Vite がホームを配信し、資料ごとの Slidev 開発サーバーへ振り分けます。Node 側の実装変更は再ビルド・再起動が必要です。静的ビルドの出力先は `packages/slidock/artifacts/official-themes/site/` で、`preview:slidock` がその内容を配信します。`apps/slidock-server`（既定4180番）と `apps/slidock-worker` は公開・配信用の別エントリーポイントです。

各コンポーネントの詳細な利用手順は、以下のドキュメントを参照してください。

- `guides/slidock-service.md`
- `guides/slive-tools.md`
- `guides/cli.md`
- `guides/publication-jobs.md`
- `guides/workers.md`
- `guides/web-customization.md`

## プロバイダー共通サーバー開発

共通サーバー（[`packages/server`](../packages/server)）の導入により、中核ロジックと実行環境・永続化層が分離されました。`apps/slidock-server` の開発は Node.js と pnpm のみで完結し、Rust ツールチェーンは不要です。環境設定の詳細は [プラットフォーム導入ガイド](guides/platforms.md) を参照してください。

| レイヤー | 配置場所 | 役割と責務 |
| :--- | :--- | :--- |
| コア | `packages/server` | 共通 HTTP 処理、配信処理、コンパイラ（プロバイダー SDK 依存なし） |
| アダプター | `packages/adapter-cloudflare`, `packages/adapter-node` | Cloudflare Worker および Node.js 環境向けバインディング接続 |
| 永続化層 | `packages/storage-s3`, `packages/storage-gcs`, `packages/state-postgres` | S3 / GCS 成果物保存、PostgreSQL の配信・公開ジョブストア実装 |
| アプリ | `apps/slidock-server`, `apps/slidock-worker` | 各プラットフォーム向けサーバーのエントリーポイント |
| ランタイム | `apps/slidock-worker/scripts/build-runtime.mjs` | 共有ランタイムアセットの生成 |

ローカル開発時はランタイムをビルドした上でローカル変更を許可して起動します。

```bash
pnpm build:server-runtime
HUB_ALLOW_LOCAL_MUTATIONS=true HUB_JOBS_ENABLED=true pnpm dev:server
```

パッケージング検証は CLI（`pnpm pack:cli`、既存5パッケージ）とサーバーライブラリ（`pnpm pack:server`、9パッケージ）で独立しています。コード変更時は以下の検証ゲートを実行します。ローカル検証結果は [platform-portability.json](results/platform-portability.json) に記録されています（実クラウド受入、CI、ネイティブ検証は含まれません）。

- `pnpm check`: リント、フォーマット、型検査、テスト、パッケージ境界検証を実施。
- `pnpm verify:server`: Node アプリ、ブラウザ、CLI の E2E 検証（`HUB_TEST_DATABASE_URL` 設定時に PostgreSQL を使用したアプリ再起動後の復元検証を実行、未設定時は DB 検査をスキップ）。
- `pnpm verify:packed-server`: ワークスペース外での独立8パッケージ導入と HTTP 配信検証。
- `pnpm verify:publication-jobs`: Node/PostgreSQL とローカル Workers の公開ジョブフローを検証します。Chromium と専用の使い捨て PostgreSQL が必要です。`HUB_TEST_DATABASE_URL` には他用途と共有しないローカルテスト DB を指定してください。誤接続を防ぐため、検証スクリプトは `127.0.0.1:55461` の `hub_jobs` だけを受け付けます。

```bash
export HUB_TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:55461/hub_jobs'
pnpm check
pnpm verify:server
pnpm verify:publication-jobs
```

GitHub Actions の server job では `verify:server` の後に `verify:publication-jobs` を実行する設定です。ワークフロー定義は成功結果を意味しません。実際のローカル検証状況は [publication-jobs.json](results/publication-jobs.json) を参照してください。

## 回帰テストと検証

変更内容を網羅的に検証する際は、以下のコマンドで一括回帰テストを実行します。

```bash
pnpm check && pnpm verify:portable && pnpm verify:packed-cli && pnpm verify:workers-slive && pnpm verify:slive
```

### Docker による Node 隔離環境での検証

ホスト環境の差異を排除するため、Docker コンテナ内で隔離検証を実施できます。

```bash
docker build -f scripts/portable.Dockerfile -t slidock:portable .
docker run --rm --init --shm-size=1g slidock:portable sh -c 'pnpm check && pnpm verify:portable && pnpm verify:packed-cli'
```

`.dockerignore` により `node_modules/`、`artifacts/`、`target/`、`dist/`、`.git/`、および非公開設定はビルドコンテキストから除外されており、ホストディレクトリのマウントは行いません。依存パッケージの導入やビルドのため、コンテナ内からインターネット接続が必要です。

`portable` 検証では、実ブラウザ操作、静的配信、オフライン動作、カスタム Web、テーマ適用、HTTP/HTTPS 通信、Workers フィクスチャ、モック認証をテストします。`packed-cli` 検証では、外部の一時ディレクトリに非公開の 5 つの tarball パッケージを実際にインストールして動作を確認します。

### ネイティブ環境の検証（apps/slive）

`apps/slive` のネイティブ機能に関する 2 段階のゲート検証には、Rust に加えて Linux SDK およびディスプレイ環境（Xvfb 等）が必要です。詳細は [../apps/slive/README.md](../apps/slive/README.md) を参照してください。

コアおよびホスト機能のテストは、並列ジョブ数を指定して実行します。

```bash
CARGO_BUILD_JOBS=2 cargo test --locked --manifest-path apps/slive/Cargo.toml -p slive-core -p slive
```

必須の SDK が導入されていない環境では検証を行わず「未検証」として扱ってください。Node.js 側のテストが合格しても、ネイティブ機能が合格したとはみなせません。

## CI パイプラインと検証記録の扱い

検査範囲を保ったまま CI の負荷と所要時間を減らすため、[.github/workflows/checks.yml](../.github/workflows/checks.yml) は `changes`、`portable`、`server`、`framework`、`rust-core`、`native` の 6 ジョブ構成としている。基本検査を毎回実行しつつ、変更内容に応じて重い検証対象だけを選択し、独立したスイートを並列に実行できる構成とした。機能ごとの検証一覧は [results/README.md](results/README.md) に、完了した計画は [archive/README.md](archive/README.md) にある。なお、`results/final-regression.json` は 2026-10-10 時点のローカルスナップショットであり、現在の CI 成功を証明するものではない。

### ジョブ構成と変更検出

`rust-core` は `needs` を持たず毎回実行し、`portable`・`server`・`framework`・`native` の 4 ジョブは [scripts/ci-changes.mjs](../scripts/ci-changes.mjs) を実行する `changes` ジョブの完了だけを待って並列に実行可能となる（実際に並列で開始できるかはランナー枠に依存する）。以前は `portable` → `rust-core` → `native` を直列で実行していたが、`native` は必要なビルドを自身のジョブ内で行うため、`portable` や `rust-core` の完了を待たない。

`changes` ジョブは `git diff --no-renames -z` を使い、`push` では `before..after` 全体の差分、プルリクエストでは `merge-base(base.sha, head.sha)..head.sha` の差分を対象に、追加・削除および改名時の旧新両方のパスを収集する。差分の比較ができない場合、初回 `push` のゼロ SHA の場合、未知のイベントの場合、および `workflow_dispatch` による手動実行の場合は、すべての重い検証を実行する判定にする。

`portable` ジョブでは毎回 `pnpm build:packages` に続いて `pnpm check` を実行する。重い検証が不要な変更では軽いビルド（`pnpm build:workers` と `pnpm build:slive-ui`）だけを専用ステップで走らせ、重い検証を実行するときは同じビルドが `verify:portable` 内に含まれるため追加では実行しない。

### ジョブと検証コマンドの対応

各ジョブで実行するコマンドと前提条件は以下のとおり。`rust-core` と `portable` 内の基本検査・軽量ビルドは毎回実行し、それ以外の重い検証は `changes` の判定結果に応じて実行する。

| ジョブ | 実行条件 | 検証コマンド・対象 | 依存サービス・前提 |
| --- | --- | --- | --- |
| `portable` | 毎回 | `pnpm build:packages`、`pnpm check`（`lint`, `format:check`, `typecheck`, `test`, `check:boundaries`）、軽量ビルド `pnpm build:workers` / `pnpm build:slive-ui`（重い検証内または専用ステップ） | PostgreSQL `hub` サービスと `HUB_TEST_DATABASE_URL` を維持し、`pnpm check` の DB テストを有効のまま実行 |
| `portable` | 条件付き | `pnpm verify:portable --skip-checks`（`build:slidock`, `verify:slidock`, `verify:web-customization`, `build:slidock:fixtures`, `verify:slidock:fixtures`, `slive:prepare`, `build:slive-ui`, `node apps/slive/scripts/verify-remote.mjs`, `build:example:watabegg`, `verify:example:watabegg`, `verify:workers`［`build:workers` を含む］, `pnpm --filter @slidock/workers verify:fixtures`, `pnpm --filter @slidock/workers verify:auth` をすべて保持）、`pnpm verify:packed-cli` | 直前の `pnpm check` 成功を前提に `--skip-checks` を指定 |
| `server` | 条件付き | `pnpm verify:packed-server`、`pnpm verify:server`、`pnpm verify:publication-jobs`（後者 2 つは `build:workers` を含む） | PostgreSQL `hub` と破棄可能な `127.0.0.1:55461/hub_jobs` を別サービスとして維持 |
| `framework` | 条件付き | `pnpm verify:packed-framework`、`pnpm verify:framework-frontend`、`pnpm verify:pages`（`verify-pages-subpath.mjs` と `verify-pages-dev.mjs` の両方） | なし |
| `rust-core` | 毎回 | `cargo test --locked --manifest-path apps/slive/Cargo.toml -p slive-core -p slive` | `needs` なしで開始 |
| `native` | 条件付き | `pnpm build:slidock:fixtures`、`xvfb-run -a dbus-run-session -- sh -c 'pnpm verify:workers-slive && pnpm verify:slive'` | `changes` の完了後、自身のジョブ内でビルドするため `portable` や `rust-core` の完了待ち不要 |

### 変更パスと必要な重い検証スイート

重い検証スイート（`portable`、`framework`、`server`、`native`）の対象判定は保守的に設計している。複数ファイルが変更された場合は、各パスに該当するスイートの和集合を実行する。なお、`docs` 以外の Markdown ファイルを一律に除外対象にすることはない。

| 変更されたパス | 実行する重い検証スイート | 判定理由・補足 |
| --- | --- | --- |
| `docs/**`、ルートの `AGENTS.md`、`TODO.md` のみ | なし | `docs` 配下の任意ファイルが該当（ルートの `README.md` や `LICENSE` は除外対象に含まない） |
| `packages/{protocol,slidev-adapter,slidock}/**` | `portable`, `framework`, `server`, `native` | ビルダー、ブラウザ、CLI、`server` 経由ですべてのスイートが推移的に依存するため |
| `packages/{cli,slive-tools,server,adapter-cloudflare}/**` または `apps/slidock-worker/**` | `portable`, `server`, `native` | CLI、Workers 配信、公開、native 検証が参照するため |
| `packages/{adapter-node,storage-s3,storage-gcs,state-postgres,renderer-playwright}/**` または `apps/slidock-server/**` | `server` | Node / packed サーバーおよび公開ジョブが参照するため |
| `apps/slive/**` | `portable`, `native` | ブラウザの remote 検査も Slive UI 等を参照するため |
| `examples/**` | `portable`, `framework`, `native` | 公式テーマ、custom frontend、ネイティブと Workers の共通 fixture 群であり、内部の差を細分化せず保守的に扱うため |
| 上記以外 | `portable`, `framework`, `server`, `native` | `.github/workflows/**`、ルートの `package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`、`scripts/**`、`README.md`、`LICENSE`、新規の未分類パスを含む |

### ビルド再利用・キャッシュ・実行制御

`portable`・`server`・`framework`・`native` の 4 ジョブは、最初に無条件で `pnpm build:packages` を実行して成功後に `SLIDOCK_PACKAGES_BUILT=1` を `GITHUB_ENV` へ設定する。`package.json` の `build:packages:if-needed` スクリプトはこの環境変数が `1` のときだけビルドを省略し、それ以外は `build:packages` へ処理を委譲する。ビルド成果物キャッシュの正しさには依存せず、実行ごとに新しくビルドを行う。

ローカルで `pnpm verify:*` を単体実行する場合は既定の自動ビルドを維持しており、`verify:portable` も最初に一度ビルドして以後は再利用し、既定の `typecheck` と `test` も維持する。`--skip-checks` は直前の `pnpm check` 成功を前提にチェックを省略するフラグであり、手動で指定すればローカルでも省略できる。ローカルで複数コマンドを連続実行する際にビルドを明示的に再利用したい場合は、`pnpm build:packages` の成功後に `SLIDOCK_PACKAGES_BUILT=1 pnpm verify:packed-cli` のようにコマンド単位で渡す。ソースを編集したあとは再度ビルドを実行し、環境変数をシェルへ恒久的に `export` しない。

`actions/cache` による再利用対象と管理方針は次のとおり。

- **pnpm ストア**: `actions/cache` で再利用する。
- **Playwright ブラウザ**: OS・アーキテクチャ・lockfile のキーでキャッシュする。
- **apt パッケージ**: ダウンロード済みの `.deb` を `browser` 用と `native` 用に分けてキャッシュする。
- **Cargo**: `registry` / `git` / `target` を `rust-core` 用と `native` 用に分けてキャッシュし、OS・アーキテクチャ・`rustc` バージョン・manifest・lockfile・commit でキーを構成する。同一 lockfile と toolchain のプレフィックス一致で過去の `target` を再利用する。
- **OS 依存パッケージの適用**: apt や Playwright の OS 依存インストール処理はキャッシュヒット時にも毎回実行し、OS にインストール済みの状態自体はキャッシュしない。

ワークフロー内で使用する action はすべて `actions` 公式のものとし、commit SHA で固定している。また、`concurrency` はワークフロー・イベント・ref 単位で古い実行を取り消し、`push` とプルリクエストが互いの実行を取り消さないようにしている。

### 所要時間の実績と見積もり

変更前の成功実行（run `45363069940`）における実測時間は、`portable` が 11m47s、`framework` が 3m08s、`rust-core` が 1m18s、`native` が 6m22s であり、`portable` → `rust-core` → `native` の直列実行によって待ち時間を除いても合計約 19m27s を要していた。

変更後はランナー枠が十分に確保できる前提で、`docs` のみなど重い検証を伴わない変更は 3〜5 分、すべての重い検証スイートが実行される変更は 7〜10 分と見込んでいる。ただし、この見積もりは未実測であり、コールドキャッシュやランナー待ちが発生した場合はこれより長くなりうる。また、[Playwright 公式](https://playwright.dev/docs/ci#caching-browsers)もブラウザキャッシュの復元がダウンロードより速いとは限らないと案内しているため、CI 全体やキャッシュによる短縮効果は未検証とし、短縮幅は確定させない（変更の push 後に実測して確認する）。

## 互換用環境変数と実験コードの分離

従来のラッパー向けに以下の互換環境変数が用意されており、設定が存在する場合は優先順位に従って適用されます。

1. `SLIDEV_THEME_PATH`（最優先）
2. `SLIDEV_LAB_THEME`
3. `SLIDEV_THEME_DIR`

`SLIDEV_LAB_DEPENDENCY_ROOT` は実験用です。新しい API や CLI ではこれらを使用せず、明示的な設定を参照してください。

現行 Slive のフレーム維持・描画待ち・競合処理は `apps/slive/scripts/verify-flicker.mjs` で検証します。過去版の比較ハーネスと計測記録は [DECISIONS.md](DECISIONS.md) 内の固定 Git リンクから参照できます。

## ランタイムアップグレードのローカル検証

ランタイム固定機能のアップグレード検証は、実際のクラウド環境を使用せず、破棄可能なローカルPostgreSQLおよびローカルNode / workerd（Durable Objects）環境で実施します。次のコマンドで検証を行います。

```bash
export HUB_TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/DATABASE'
pnpm verify:runtime-upgrade
```

このコマンドはデフォルトテーマ（A）と `slidev-theme-watabegg@1.2.1`（B）を順次ビルドし、同一MarkdownをNode/PostgreSQLとローカルworkerdへ公開します。元のテーマAの静的パスを削除した上でテーマBにより再起動し、新旧両方のブラウザアセット名前空間と描画結果を確認します。生成されたログやスクリーンショットはGit管理外の `artifacts/runtime-pinning` に出力されます。本検証はローカル専用でありCIには追加されていません。検証結果の集約状況は [docs/results/runtime-pinning.json](results/runtime-pinning.json) を参照してください。
