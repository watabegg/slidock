# Slidock

複数の Slidev 資料の共通バンドルと Web フロントエンド API を提供するフレームワークです。互換性のある資料間でモジュールを共有し、異なるテーマや設定の資料は分けてビルドします。

## 公開エントリーポイント

| import 元 | 用途 |
| --- | --- |
| `@slidock/slidock`（`/node` 別名） | `buildHub`、`devHub`、設定の正規化、サムネイル生成 |
| `@slidock/slidock/serve` | 静的成果物のローカル配信 |
| `@slidock/slidock/client` | カタログ取得、公開ジョブの状態取得 |
| `@slidock/slidock/frontend` | `SlidockHome`、`SlideCard`、`CategoryNav`、`useCatalog`、互換マウント API |
| `@slidock/slidock/frontend/style.css` | 標準画面のスタイル（明示 import） |
| `@slidock/slidock/frontend/job-status.css` | 公開ジョブ画面のスタイル |
| `@slidock/slidock/icon.svg` | Slidock アイコン |

利用方法は [Node API](../../docs/guides/slidock-service.md)、[Web フロントエンド API](../../docs/guides/web-customization.md)、[公開ジョブ](../../docs/guides/publication-jobs.md) を参照してください。npm への一般公開は未実施です。

## リポジトリ内で動かす

以下はリポジトリのルートから実行します。

```sh
# 公式テーマの利用例をホットリロード付きで起動（localhost:4174）
pnpm dev:slidock

# 同じ利用例を静的ビルドして配信
pnpm build:slidock
pnpm preview:slidock

# 共有バンドルの回帰用フィクスチャ
pnpm build:slidock:fixtures
pnpm verify:slidock:fixtures
```

公式デモのソースは `examples/official-themes/`、回帰用データは `examples/fixtures/` です。開発サーバーは資料ごとの Slidev 開発ランタイムを使います。共通バンドルの生成は静的ビルドの経路で確認します。

公開マニフェストにはローカルのソースパスや発表者ノートを含めず、Slive の準備には非公開ビルドレシートを使います。既定テーマはインストール済みの `@slidev/theme-default` です。テーマ指定やブラウザの準備は [開発ガイド](../../docs/DEVELOPMENT.md) を参照してください。

## 検証

```sh
pnpm --filter @slidock/slidock typecheck
pnpm --filter @slidock/slidock test
```

実施済みの範囲と制限事項は [検証記録](../../docs/results/README.md) を参照してください。
