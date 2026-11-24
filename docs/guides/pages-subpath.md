# 自動 Vue ホームとサブパス配信

Next.js の `page.tsx` に類似したファイル配置規約を用いて、`main.ts` や `createApp` による初期化コードを書かずにカスタムホーム画面を構築できます。あわせて、特定のサブパス配下にスタンドアロンで展開する配信機能を提供します。高度な埋め込み構成については、既存の [framework.md](framework.md) を参照してください。

## 設計方針

執筆用のファイル配置規約とデプロイ時のマウントパスを分離し、汎用的なルーティングフレームワークの導入を避けながら、高度な用途に必要な埋め込み用 API や明示的なエントリ指定の手段を残します。

## プロジェクト構成と規約

プロジェクトの基本構成は次のとおりです。

```text
├── slidock.config.ts
├── pages/
│   └── index.vue
└── slides/
    └── welcome/
        └── slides.md
```

CLI および `loadProject` は、対象の `slidock.config.ts` と同じ階層（設定ファイルがない場合はプロジェクトルート）にある `pages/index.vue` を自動的に検出します。

- `pages/index.vue` がない場合は、標準のホーム画面が表示されます。
- 設定で `frontendEntry` が明示されている場合は、その指定が優先されます。
- 従来の `hub.config.json` では明示的なエントリ指定の動作が維持されます。低レベル API の `buildHub` は直接 `frontendEntry` を受け取り、ファイル配置による自動選択は `loadProject` を経由した場合にのみ機能します。
- 汎用的なページルーターは提供せず、ホーム画面用として `pages/index.vue` のみが予約されています。

## カスタムホームの実装

`pages/index.vue` はフレームワークによって自動的に `#app` にマウントされ、フレームワークのコンポーネント用スタイル（`style.css`）と全画面用スタイル（`site.css`）が適用されます。`main.ts` や `createApp` を用意する必要はありません。

```vue
<script setup>
import { SlidockHome, useCatalog } from '@slidock/slidock/frontend';

const { catalog, pending, error, reload } = useCatalog();
</script>

<template>
  <div v-if="pending">読み込み中...</div>
  <div v-else-if="error">
    <button @click="reload">再試行</button>
  </div>
  <SlidockHome
    v-else-if="catalog"
    :catalog="catalog"
    title="研究室の資料"
  >
    <template #card="{ deck, href }">
      <a :href="href">{{ deck.title }}</a>
    </template>
  </SlidockHome>
</template>
```

`slidock.config.ts` の `home` 設定は標準ホーム画面が使用するものであり、ユーザーが作成した Vue ファイルへ自動的にプロパティとして渡されることはありません。カスタムホーム画面のタイトルや独自設定は、コンポーネント自身のプロパティやデータとして管理します。

## サブパス配信設定

特定のサブパス配下に展開する場合は、`slidock.config.ts` で `basePath` を指定します。

```ts
import { defineConfig } from '@slidock/slidock';

export default defineConfig({
  basePath: '/slides/',
});
```

- デフォルト値は `'/'` です。
- `'/slides'` と指定した場合も正規化されて `'/slides/'` として扱われます。`'/docs/slides/'` のような階層構造も指定可能です。
- パスセグメントに使用できる文字は、ASCII 英数字および `.`、`_`、`~`、`-` です。空のセグメント、`.`、`..`、クエリ文字列、フラグメント、`%` エンコーディングは使用できません。
- 設定により、ホーム（`/slides/`）、スライド本文（例: `/slides/welcome/1`）、カタログ、アセット、サムネイルの各 URL にプレフィックスが付与されます。ルート（`'/'`）配信時は従来のまま変更されません。
- `navigation.homeHref`、`home.links`、`logo`、`deckHref`、明示的なカタログソースなど、設定で直接指定した URL は自動的に書き換えられず、指定した値が維持されます。

## 開発とプレビュー

パッケージはパブリックレジストリへ未公開のため、すでにインストールされている環境を前提とします。操作には以下のコマンドを使用します。

```bash
npx slidock dev
npx slidock build
npx slidock preview
```

- 開発中の Vue ファイルの変更には HMR（ホットモジュール置換）が機能します。`pages/index.vue` を追加または削除した場合は、ブラウザのリロードによってカスタム画面と標準画面が切り替わります。
- 開発サーバーの起動中に `basePath` を変更した場合はサーバーの再起動が必要です（直前の状態を保ったまま対処方法を示すエラーが表示されます）。汎用ルーターのような設定変更のホットリロードは保証されません。
- ビルドの成果物は `dist/slides` のようなサブパス構造には出力されず、従来の `dist/index.html`、`dist/catalog.json`、`dist/assets/`、`dist/_profiles/...` という配置を維持します。デプロイ時は、このディレクトリを指定したマウントパス配下に配置してください。
- ホスト側の Web サーバーは、スライドのディープリンク（例: `/slides/welcome/2`）へのアクセスを、対応するデッキのエントリ index へフォールバックさせる必要があります（`slidock preview` による静的プレビュー環境では自動的に処理されます）。
- `slidock preview` は、後から変更された設定ファイルではなくビルド時のマニフェストに記録されたベースパスを読み取ります。末尾のスラッシュがないマウントパスへのアクセス時は、クエリパラメータを維持したまま 308 リダイレクトを行います。

## クライアント API と既存アプリケーションへの組み込み

ブラウザ環境向けに、`@slidock/slidock/client` から `getSiteBasePath()` が提供されています。フレームワークのメタデータを読み取ってベースパスを取得し、メタデータが存在しない場合は `'/'` にフォールバックします。

- `useCatalog()` や `getCatalog()` のデフォルトエンドポイント、および `SlidockHome` やナビゲーションのデフォルトの `homeHref` は設定したベースパスに追従します。明示的に指定されたソースは変更されません。
- 独自にリンクを生成する場合は、ベースパスが `'/'` であると決め打ちせず、`getSiteBasePath()` を利用してください。
- `/slides` などのパスに配置された既存の Vue や Nuxt のルートから、フロントエンドコンポーネントやクライアント API を直接利用することも可能です。この構成では `pages` 規約は不要であり、ホスト側のルーターが URL を管理します。
- 自動生成されたページの外側ではメタデータによるベースパスの自動推論が行われないため、必要に応じて `useCatalog` に明示的なカタログソース（例: `createHttpCatalogSource({ url: '/slides/catalog.json' })`）を渡してください。React 用コンポーネントの提供はありません。

## ネイティブ環境の対応と検証状況

- ルートパス（`'/'`）における既存のネイティブ Slive は動作変更ありません。
- 今回のサブパス対応は Web 配信限定です。`native-player.json` には対応デッキが含まれず、`unsupportedDecks` にマウントパス非互換の理由が出力されます。既存のネイティブプロトコルは `/{id}/1` の形式を前提としており、Rust 実装や通信仕様の変更は行っていません。空のコレクションは従来通り非対応の空データとして出力されます。Slive でのサブパス対応は残課題であり、ネイティブ環境での動作は保証されません。
- ローカルのチェック、ブラウザ検証、隔離した npm・pnpm 利用側の検証を実施しました。検証範囲と結果は [../results/pages-subpath.json](../results/pages-subpath.json) を参照してください。
