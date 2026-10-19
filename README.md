# Slidock

Slidock は、複数の Slidev 資料で共通バンドルを生成し、資料を表示する Web フロントエンドの API を提供するフレームワークです。利用者は自分の資料と画面を組み合わせてサイトを作れます。

- **共通バンドル**: Slidev のバージョン・テーマ・setup・コンパイル設定が一致する資料間でモジュールを共有します。互換性の異なる資料は分けてビルドします。
- **Web フロントエンド API**: カタログ取得用クライアントと、ホーム・カード・カテゴリ選択などの Vue コンポーネントを提供します。

本リポジトリにはフレームワーク本体に加え、利用例、公開・配信用サーバー、発表操作用デスクトップアプリ「Slive」があります。

## 主な構成要素と配置

パッケージ群はワークスペース内の名前空間として npm スコープ `@slidock` 配下に配置されています。主要なディレクトリ構成は以下のとおりです。サーバー、アダプター、ストレージ関連パッケージはそれぞれ責務を分離しています。

- `packages/slidock`: フレームワーク本体（ビルド・開発サーバー・Web API）
- `examples/official-themes`: フレームワークを使う公式テーマのデモサイト
- `examples/custom-frontend`: Web フロントエンドのカスタマイズ例
- `apps/slive`: デスクトップ環境
- `packages/slive-tools`: デスクトップ支援ツール
- `apps/slidock-worker`: 配信ワーカー
- `apps/slidock-server`: サーバー実装

## 前提条件

- Node.js >= 24.15.0
- pnpm 12.3.4
- セットアップおよびビルド時のインターネット接続

Slidock の Node.js 環境やブラウザ向け開発では、Rust のインストールは不要です。

## デモを動かす

リポジトリのルートディレクトリで以下のコマンドを実行し、依存関係の解決とブラウザのセットアップを行ったあと、Slidock を使った公式テーマのデモを起動します。

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm dev:slidock
```

起動後、[http://localhost:4174](http://localhost:4174) に公式テーマ5種類の資料一覧が表示されます。ホームの組み立ては [examples/official-themes/App.vue](examples/official-themes/App.vue)、資料は `examples/official-themes/slides/` にあります。スライドの Markdown とホームの Vue/CSS は保存時に自動反映されます。

`dev:slidock` は資料ごとの Slidev 開発サーバーを使います。共通バンドルを生成した結果を確認するには、`pnpm build:slidock` の後に `pnpm preview:slidock` を使います。このデモはテーマごとに互換グループが分かれます。同一テーマの複数資料を使う検証用データは `examples/fixtures/` にあります。

自分のサイトへ組み込む場合は [Node API](docs/guides/slidock-service.md) と [Web フロントエンド API](docs/guides/web-customization.md) を参照してください。

## Slive と CLI の利用

### Slive（デスクトップアプリ）
Slive では、サムネイルや frontmatter から資料を選択できるカテゴリ別のホーム画面、検索、アイコンを中心とした操作画面が実装されています。誤操作を防ぐため、スライド本文のクリックによるページ送りは行われません。

ホーム左下の「設定」（資料表示中は右上の歯車）から、外観（ライト・ダーク・システム）と接続先を変更できます。「このPCの資料」は起動時に指定したローカル資料を使い、「Slidock のURL」は公開先または localhost のルートURLを使います。外観は即時反映され、接続先は検証・保存後の再起動で切り替わります。

実行には Linux SDK、Rust、およびディスプレイ環境が必要です。準備手順の詳細は [apps/slive/README.md](apps/slive/README.md) を参照してください。以下のコマンドでデスクトップアプリを起動します。

```bash
pnpm slive:prepare
pnpm slive
```

### CLI の利用
ビルド後、各 CLI のヘルプを確認できます。旧 CLI 名（`hub` および `stage`）も互換用の別名（alias）として引き続き利用できます。

```bash
pnpm build:packages
pnpm slidock --help
pnpm slive:cli --help
```

## サンプル実行

`pnpm build:slidock` / `pnpm dev:slidock` では、Slidev公式の Default・Seriph・Shibainu・Bricks・Apple Basic のサンプルをテーマ別に表示します。ホームのVueコンポーネントは [examples/official-themes/App.vue](examples/official-themes/App.vue)、サンプルの出典とライセンスは [examples/official-themes/README.md](examples/official-themes/README.md) を参照してください。

Node API の既定のテーマには `@slidev/theme-default` を使用します。追加テーマ `slidev-theme-watabegg`（バージョン 1.2.1）を使用したサンプルは、以下のコマンドでビルドおよび起動できます。起動後はブラウザで `http://localhost:4175` にアクセスしてください。

```bash
pnpm build:example:watabegg
pnpm dev:example:watabegg
```

## 共通サーバーの実行と構成

共通サーバーでは、公開・配信の中核ロジックを単一のコアで共有しながら実行基盤を選択できます。ローカル環境では以下の手順でサーバーを起動します。

```bash
pnpm build:server-runtime
HUB_ALLOW_LOCAL_MUTATIONS=true pnpm dev:server
```

サーバーはデフォルトで `127.0.0.1:4180` で待機します。ローカル起動時のファイルシステム保存やインメモリ公開ストアは開発専用の構成です。本番環境では Amazon S3、Google Cloud Storage、PostgreSQL、または Cloudflare を組み合わせた構成を想定しています。構成手順の詳細は [docs/guides/platforms.md](docs/guides/platforms.md) を参照してください。

## 互換性と移行

新ブランドへの移行に伴い、パッケージのインポート元は新しいスコープ（`@slidock`）へ更新する必要があります。既存環境との後方互換性を保つため、以下の設定や識別子は維持されています。

- **CLI コマンド**: 旧コマンド `hub` および `stage` を互換 alias として維持
- **設定ファイル**: `hub.config.json`、`hub.remote.json`、`stage.config.json`、および `.slidev-stage` の保存先パス
- **環境変数**: `HUB_*` プレフィックスの環境変数群
- **API 契約**: HTTP/JSON 契約および `mountHub` などの既存 API 識別子
- **アプリ識別子とデータ**: Tauri の識別子 `local.slidev.lab` およびノートの保存先パス

今回の名称変更作業に、npm へのパッケージ公開やクラウド実環境へのデプロイは含まれません。

## 開発状況と制限事項

本リポジトリは開発途上にあり、以下の項目は未完了または未検証です。

- **パッケージとアプリの配布**: npm への一般公開および Slive のネイティブインストーラー作成は未整備です。
- **未検証の環境**: Windows 環境、物理的な 2 画面環境、実際の Cloudflare Access と連携した動作は未検証です。
- **クラウド配備**: 実際のクラウド環境への配備および受け入れ検証は未完了です。
- **UI とアセット**: UI すべての刷新が完了したわけではなく、Web UI の改善は引き続き必要です。両アプリのアイコンと favicon は採用済みです。
- **ライセンス**: ライセンス形態は未決定です。

### 検証の記録
[検証記録の一覧](docs/results/README.md) から対象機能・日付・制限事項を確認できます。各記録は実施時点のものであり、現在の作業ツリー全体の検証成功を意味しません。過去の記録には当時の旧名称・パスが含まれています。

## 関連ドキュメント

開発手順や各種仕様の詳細は、以下のドキュメントを参照してください。

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): 開発および検証の手順
- [docs/DECISIONS.md](docs/DECISIONS.md): 設計方針と採択理由
- [docs/guides/cli.md](docs/guides/cli.md): CLI の利用方法と導入手順
- [docs/guides/publication-jobs.md](docs/guides/publication-jobs.md): CLI からの非同期公開、ジョブ運用、確認リンク
- [docs/guides/web-customization.md](docs/guides/web-customization.md): Web 画面の差し替え手順
- [docs/guides/workers.md](docs/guides/workers.md): Worker のローカル検証と公開 API
- [docs/guides/slidock-service.md](docs/guides/slidock-service.md): Slidock の Node API 詳細
- [docs/guides/slive-tools.md](docs/guides/slive-tools.md): Slive ツールの API 詳細
- [docs/guides/platforms.md](docs/guides/platforms.md): プラットフォーム導入ガイド
- [TODO.md](TODO.md): 今後の課題一覧
- [apps/slive/README.md](apps/slive/README.md): Slive のセットアップ手順と詳細仕様
