# CI 検証の安定化 検証記録

`verify-remote` 検証をローカルで再現して特定した原因は、Vue のページ再入場トランジションに伴う一時的な非表示状態で bridge が誤って失敗を返していたこと、および検証スクリプト側が失敗通知を待機条件に含めず ACK だけを待ち続けていたことにある。成功したチェック数や操作、エラーのスタックトレースが一致することから、CI 上の HTTP タイムアウトでも同じ競合が起きたと考えられる。12 秒の期限内で過渡的な透明状態を許容して再待機するように bridge を修正し、検証スクリプトも失敗通知の受信や実際の DOM 条件を待つように改めた結果、修正対象の各検証が直列 3 回連続で成功することを確認した。あわせて CI 関連スクリプトおよびテストファイル 53 件を監査し、今回は変更しない 8 件の候補と据え置きの理由を整理した。

## 対象と制約

本記録は 2026-11-24 時点の `main` ブランチ（基点コミット `4f9f4763199486dd2b1944e69dd17fe0cbe43ebb` ＋未コミット差分）に対する修正と検証の結果をまとめたものである。対象は remote 検証における HTTP タイムアウトの原因修正、CI スクリプトの監査、および修正後の 3 回以上の検証実行である。

- **共有作業ツリー**: 他作業者が [checks.yml](../../.github/workflows/checks.yml)、[package.json](../../package.json) の scripts、および [verify-portable.mjs](../../scripts/verify-portable.mjs) を変更中のため、今回の担当はこれらを編集していない。他作業者による [ci-changes.mjs](../../scripts/ci-changes.mjs) と [ci-changes.test.mjs](../../scripts/ci-changes.test.mjs) も差分に含まれており、`pnpm check` などの実測はこの共有ツリー全体に対する結果である。コミットと push は行っていない。
- **実行環境**: Node v24.22.1、pnpm 12.3.4、Chromium 153.0.8010.12、Linux 上で実行した。GitHub Actions 上の全量 CI やクリーンコンテナでの実行ではない。

## 原因の証拠と切り分け

### CI ログとローカル再現の事実

GitHub Actions の run `45363069940`（attempt 1）における `portable` ジョブ（ID: `138337729255`）のログを以下のコマンドで取得し、[ci-attempt-1.log](../../artifacts/ci-stability/ci-attempt-1.log) に保存した。

```bash
gh api --allow-escape-sequences repos/watabegg/slidock/actions/jobs/138337729255/logs
```

ログによると、HTTP 検証で 9 件のチェックが成功したあと、`verify`（修正前コードの旧 201 行目）から呼び出された `setState` 内の `page.waitForFunction`（修正前の旧 88 行目、18000ms タイムアウト）でタイムアウトして失敗し、後続の HTTPS 検証は 33 件すべて成功していた。当時の `setState` は、`nativeRendered` の `deckId`・`page`・`clickIndex`・`sessionRevision` のすべてが送信した状態と一致することだけを待機条件としており、bridge 側の失敗通知を待機対象に含めていなかった。

修正前の `node apps/slive/scripts/verify-remote.mjs` をローカルで 1 回実行したところ、終了コード 1 で失敗し、CI と同じ「HTTP 9 件成功後にタイムアウト、HTTPS 33 件成功」の症状が再現した（[remote-baseline.log](../../artifacts/ci-stability/remote-baseline.log)、[baseline-result.json](../../artifacts/ci-stability/baseline-result.json)、[baseline-failure.png](../../artifacts/ci-stability/baseline-failure.png)）。このとき `hostState.errors` には `Error: rendered route differs from Rust state` が記録されていた。

### ローカルトレースから判明した競合メカニズム

調査用の一時的なトレース版（追跡コードは `artifacts` 配下のみ）を実行したところ、通常の最初のトレース試行（[trace.log](../../artifacts/ci-stability/trace.log)）は終了コード 0 で成功し、別の試行では終了コード 1 で同じ「HTTP 9 件成功後に失敗・HTTPS 33 件成功」が再現した（[trace-1.log](../../artifacts/ci-stability/trace-1.log)、[trace-1.json](../../artifacts/ci-stability/trace-1.json)）。トレースが記録した状態遷移は「初期表示 → `1:0` → `2:0` → `2:1` → `2:2` → `3:0` → `1:0`」であり、失敗したのは最後の同じ資料（1 ページ目）へ戻る操作（`sessionRevision: 6`、`page: 1`、`click: 0`）だった。

この戻り操作における DOM とルーターの経過は次のとおりである。

1. **893.1ms**: 1 ページ目は直前の離脱トランジション（`fade-leave-active` / `fade-leave-to`）の途中にあり、`opacity` が `3.41335e-11`（0 より大きい極小の正数）だった。
2. **895.8ms**: `router.replace('/1')` が完了し、ルートは `/1`、`clicks` は `0` になった。一方、DOM は `fade-enter-from` / `fade-enter-active` へ切り替わった。
3. **904.4ms**: DOM の `opacity` が `0` になり、次の `requestAnimationFrame`（rAF）の時点でも `0` だった。
4. **921.6ms**: `enter-to` へ移行しても、その時点では `opacity` が `0` だった。

修正前の `currentSlide` は `opacity != 0` であれば表示済みと判定していた。そのため、`router.replace('/1')` 完了後の最初の判定でも、残っていた極小の正数の `opacity` によって表示済み扱いとして先に進み、画像・フォントの待機と 2 回の rAF を経て 1 度だけ再検査した。その再検査時に `opacity` が `0` になっていたため `!slide`（表示中のスライドが存在しない）と判定され、`rendered route differs from Rust state` を送出した。実際にはルートも `/1`、クリック数も `0` に到達していたため、このエラーメッセージ自体は原因を正しく表していなかった。

すなわち原因は、メッセージやイベントリスナーの取りこぼしではなく、Vue の再入場トランジションと bridge 側の「2 rAF 後に 1 回だけ検査する」処理の順序競合である。さらに、`nativeFailure` はホストへ届いていたにもかかわらず、`verify-remote` がそれを参照せず ACK を待ち続けたため 18000ms のタイムアウトとなった。

### 事実と推論の境界

CI 実行時には各時点の DOM 状態や `hostState` を保存していないため、CI 上でローカルと完全に同じ順序の割り込み（interleaving）が起きたとまでは断定できない。しかし、成功したチェック数、操作内容、エラーのスタックトレースが一致し、ローカルでも同じ症状を再現できたことから、CI でも同じ競合が起きたと考える。HTTP の場合だけ発生する実装上の差異は見つかっておらず、HTTPS が成功した差もタイミングによるものと推定する。また、CPU 負荷が唯一の原因であるとも断言しない。

## 実施した変更

タイムアウト原因の解消と他の固定時間待機の置き換えとして、以下の 5 ファイルを変更・追加した。

- **[deck-bridge.ts](../../packages/protocol/src/bridge/deck-bridge.ts#L208-L242)**: 同じ 12 秒の期限内で「可視性確認 → 画像・フォント待機 → 2 rAF → 可視性再検査」を実行し、いったん非表示（透明）になった場合は即座に失敗させず待機ループを継続するように変更した。期限まで透明のままなら期限切れとして失敗し、待機中に最新の state へ変化した場合は古い状態を捨てる。ワイヤー形式、Rust 側の状態権威、通常の Web 操作、および各タイムアウト値は維持しており、本体の挙動変更は「一時的な `opacity: 0` を即エラーにしない」点だけである。継続的な非表示、画像エラー、route や click の不一致は引き続き失敗する。
- **[bridge.test.mjs](../../packages/protocol/tests/bridge.test.mjs)（新規作成）**: rAF と `opacity` を手動で制御し、`opacity` が `0` から復帰して ACK を返すケース、非表示のまま 12 秒が経過して failure になるケース、新しい state が待機中の state を置き換えるケースの 3 テストを追加した。
- **[verify-remote.mjs](../../apps/slive/scripts/verify-remote.mjs#L79-L132)**: `setState` が対応する ACK または新規の host error を待つように変更し、エラーを受けた場合は即座に `assert` へ渡すようにした。返す report は対象の `sessionRevision` で選択する。18 秒のタイムアウト値は変更していない。
- **[verify.mjs](../../apps/slidock-worker/scripts/verify.mjs#L194)**: クリック後の 350ms 固定 sleep を、`query.clicks=1` および対象要素の visibility と `opacity` を確認する条件待ちへ置き換えた。
- **[verify-library.mjs](../../packages/slidock/scripts/verify-library.mjs#L66-L75)**: 2.5 秒の固定 sleep を操作バーの実際の `opacity` が `0` になるまで待つ条件待ちへ変更した。従来の viewport（`1440x1000`）では Slidev の `isScreenVertical = height - width / aspect > 120` により `persistNav=true` が有効になり、「バーが隠れても home link が残る」という検査本来の目的を確認できていなかったため、スライド表示前に viewport を `1440x810` へ変更して常時表示を解除した。最初の条件待ち試行は旧 viewport のままだったため 30 秒で終了コード 1 となったが、viewport を修正した最終検証では 3 回成功している（[library-1.log](../../artifacts/ci-stability/library-1.log) は最終成功結果で上書き済み）。

## 実行結果

繰り返し検証はすべて直列で実行し、終了コードが 0 のものだけを成功として扱った。

| 実行コマンド | 状態・回数 | 終了コード | 結果の概要 | 記録ファイル |
| :--- | :--- | :--- | :--- | :--- |
| `node apps/slive/scripts/verify-remote.mjs` | 修正前・1 回 | 1 | HTTP 9 成功後タイムアウト、HTTPS 33 成功 | [remote-baseline.log](../../artifacts/ci-stability/remote-baseline.log) |
| `node --test artifacts/ci-stability/bridge-before.test.mjs` | 修正前・1 回 | 1 | HEAD の旧 bridge で新規 3 テストが全失敗 | [bridge-before-test.log](../../artifacts/ci-stability/bridge-before-test.log) |
| `pnpm --filter @slidock/protocol test` | 修正後・1 回 | 0 | 16 tests 成功 | [protocol-test.log](../../artifacts/ci-stability/protocol-test.log) |
| `pnpm build:slidock:fixtures` | 修正後・1 回 | 0 | 4 資料を再生成 | [build-fixtures.log](../../artifacts/ci-stability/build-fixtures.log) |
| `taskset -c 0 node apps/slive/scripts/verify-remote.mjs` | 修正後・3 回 | 0, 0, 0 | 1 CPU 制限下で毎回 HTTP 33 + HTTPS 33 成功 | [remote-fixed-1.log](../../artifacts/ci-stability/remote-fixed-1.log)〜[3.log](../../artifacts/ci-stability/remote-fixed-3.log)（各 `.json` 含む） |
| `pnpm build:workers` | 修正後・1 回 | 0 | worker ビルド成功 | [build-workers.log](../../artifacts/ci-stability/build-workers.log) |
| `pnpm --filter @slidock/workers verify` | 修正後・3 回 | 0, 0, 0 | 各回 39 checks 成功 | [workers-1.log](../../artifacts/ci-stability/workers-1.log)〜[3.log](../../artifacts/ci-stability/workers-3.log) |
| `pnpm --filter @slidock/slidock verify:library` | 修正後・3 回 | 0, 0, 0 | 3 回成功（最終結果 JSON は [result.json](../../packages/slidock/artifacts/browser-library/result.json)） | [library-1.log](../../artifacts/ci-stability/library-1.log)〜[3.log](../../artifacts/ci-stability/library-3.log) |
| `node --test packages/protocol/tests/bridge.test.mjs` | 修正後・3 回 | 0, 0, 0 | 毎回 3 tests 成功 | [bridge-fixed-1.log](../../artifacts/ci-stability/bridge-fixed-1.log)〜[3.log](../../artifacts/ci-stability/bridge-fixed-3.log) |
| `pnpm lint` | 最終差分・1 回 | 0 | lint 成功 | [lint.log](../../artifacts/ci-stability/lint.log) |
| `pnpm format:check` | 最終差分・1 回 | 0 | format 検証成功 | [format-check.log](../../artifacts/ci-stability/format-check.log) |
| `pnpm check` | 最終差分・1 回 | 0 | 425 tests（416 pass、0 fail、9 skipped） | [check.log](../../artifacts/ci-stability/check.log) |

各実行結果の補足は次のとおりである。

- **旧 bridge との対比**: [bridge-before.test.mjs](../../artifacts/ci-stability/bridge-before.test.mjs) では、作業ツリーや生成済み `dist` を上書きせずに HEAD 時点の旧 bridge を別ファイルへ bundle して新規 3 テストを実行し、修正前コードでは全件失敗することを確認した。
- **1 CPU 制限下での再現確認**: `taskset -c 0` により Node と Chromium 子プロセス全体を 1 CPU に制限した状態で `verify-remote.mjs` を 3 回実行し、いずれも HTTP 33 件・HTTPS 33 件が成功した（[remote-fixed-1.log](../../artifacts/ci-stability/remote-fixed-1.log) / [1.json](../../artifacts/ci-stability/remote-fixed-1.json)、[remote-fixed-2.log](../../artifacts/ci-stability/remote-fixed-2.log) / [2.json](../../artifacts/ci-stability/remote-fixed-2.json)、[remote-fixed-3.log](../../artifacts/ci-stability/remote-fixed-3.log) / [3.json](../../artifacts/ci-stability/remote-fixed-3.json)）。
- **共有ツリー全体の `pnpm check`**: 並行担当者の新しい CI 判定テストを含む共有ツリー全体に対して `lint`・`format`・`typecheck`・`test`・`boundaries` を完了した。`boundaries` は 0 違反・0 移行例外だった。425 テストのうち 9 件は `HUB_TEST_DATABASE_URL` が未設定である PostgreSQL 統合テストのためスキップされている。また、Wrangler 型生成では既定のホーム配下ログ出力先が sandbox の読み取り専用領域にあたるため `EROFS` が表示されたが、型生成自体と `pnpm check` の終了コードは 0 だった。これを typecheck の失敗扱いにも無警告の成功扱いにも変えず、事実のまま記録する。

## CI スクリプト監査と未修正候補

`scripts/`、`apps/*/scripts/`、`packages/*/scripts/`、および `packages/*/tests/`（追加した `bridge.test.mjs` を含む共有ツリー時点で 53 テストファイル）を対象に、待機、タイムアウト、HTTP 要求、ポートの listen、および依存順序を読み取って調査し、現行の workflow と `package.json` の scripts へ照合した。URL 文字列としての `.example`・`.test`・`.invalid` や `Request` オブジェクトの生成は実通信と区別した。

現行の CI workflow は `check`、`portable` 配下、`packed-cli`、`server`（`packed-server`・`server`・`publication-jobs` と DO 検証）、`framework`（`packed-framework`・`frontend`・`pages`）、および `native`（`workers-slive`・`slive`）へ到達する。一方、`verify-runtime-upgrade`、`verify-native-rendering`、`verify-dev-server`、`verify-vue-frontend` は現行 workflow から直接到達しない。

調査で見つかった処理のうち、`publication` や `worker` の 50〜300ms の遅延などは条件ポーリングの間隔、`verify-flicker` の sleep は意図的なドキュメント遅延や観測サンプリング、`native` の 180 秒は QA 期限、5 秒は SIGTERM の猶予であり、いずれも固定の起動完了待ちではない。`portable` の子コマンドは直列実行であり、runtime・package・fixture の前提を組む現行の依存順序に新しい欠落は見つからなかった。なお、検証用アプリの listen ポートは port 0 を使用しており、下記の再 bind 以外の固定アプリポートは検出されなかった。ただし、同一成果物ディレクトリを複数検証から同時実行する安全性は未実測である。また、外部の画像・フォント・CDN への新しい直接要求は監査範囲で見つからなかったものの、すべての生成資産の完全な通信トレースを取得したわけではなく、依存取得やオフライン資産準備のビルド段階については完全オフライン保証ではない。

以下の 8 件は、変更の必要性や再現が未確定であるか、検査目的そのものに関わるため、今回は修正せず残した。

| 対象箇所 | 挙動とリスク | 今回修正せず残した理由 |
| :--- | :--- | :--- |
| [verify-packed-framework.mjs](../../scripts/verify-packed-framework.mjs#L136-L140)（[136–140](../../scripts/verify-packed-framework.mjs#L136-L140)、[261–268 行](../../scripts/verify-packed-framework.mjs#L261-L268)） | `@slidock` のみ local registry、他依存は `registry.npmjs.org` を参照する。生成する consumer の lockfile は install 後に作成されるため、ネットワーク停止や推移的依存更新の影響を受け得る。 | 外部 consumer の導入確認という目的があり、単純に offline 化すると別の検証になるため。 |
| [verify-packed-cli.mjs](../../scripts/verify-packed-cli.mjs#L42-L43)（42–43 行）、[verify-packed-server.mjs](../../scripts/verify-packed-server.mjs#L11-L13)（11–13 行） | `prefer-offline` にはフォールバックがあり、server の install も実 registry に依存する。 | packaged consumer 検証としての性質を今回変更しないため。 |
| [verify-publication-jobs.mjs](../../apps/slidock-worker/scripts/verify-publication-jobs.mjs#L194-L202)（[194–202](../../apps/slidock-worker/scripts/verify-publication-jobs.mjs#L194-L202)、[228–240 行](../../apps/slidock-worker/scripts/verify-publication-jobs.mjs#L228-L240)） | port 0 で空きポートを取得して close し、`createConfiguredHub` へ `public origin` を設定してから再 bind する間に他プロセスが取得すると `EADDRINUSE` になり得る（固定ポートではないが TOCTOU がある）。 | 事前に `public origin` を構成へ与える必要があるため、今回起動構成を変更しない。未再現。 |
| [verify-remote.mjs](../../apps/slive/scripts/verify-remote.mjs#L240)（[240](../../apps/slive/scripts/verify-remote.mjs#L240)、[336](../../apps/slive/scripts/verify-remote.mjs#L336)、[364 行](../../apps/slive/scripts/verify-remote.mjs#L364)） | キー重複入力がないこと、および偽造・不正な state で route が変わらないことを 100ms の否定観測で確認している。100ms 以降に起きる回帰は見逃し得る。 | 起動待ちではなく、無期限に「起きないこと」は待てないため。 |
| [verify-remote.mjs](../../apps/slive/scripts/verify-remote.mjs#L180)（180 行） | クリック後の CSS 変化を 3 秒で待機する。極端な CPU 負荷下での余裕は未測定（今回 1 CPU 制限で 3 回成功）。 | ACK 後の実 DOM 条件待ちであり、タイムアウト延長の根拠がないため。 |
| [cli.test.mjs](../../packages/cli/tests/cli.test.mjs#L24-L29)（[24–29](../../packages/cli/tests/cli.test.mjs#L24-L29)、[281–295 行](../../packages/cli/tests/cli.test.mjs#L281-L295)）、[project.test.mjs](../../packages/slidock/tests/project.test.mjs#L259-L269)（259–269 行） | CLI 実行を 20 秒、起動出力を 10 秒の条件待ちで検査している。ローカル Node 環境には妥当だが、極端な runner 遅延のリスクは残る。 | タイムアウトの延長だけは行わないため。 |
| [renderer.test.mjs](../../packages/renderer-playwright/tests/renderer.test.mjs#L258)（[258](../../packages/renderer-playwright/tests/renderer.test.mjs#L258)、[263–273 行](../../packages/renderer-playwright/tests/renderer.test.mjs#L263-L273)） | wall timeout 4 秒を 5 秒以内で検査しており、スケジュール余裕が 1 秒ある。過負荷では偽陰性の余地がある。 | queue 待ちを含むタイムアウト契約自体を検査しており、単純な削除や延長を行わないため（`pnpm check` で成功）。 |
| workflow の PostgreSQL ポート（`5432` / `55461`） | workflow で明示した専用サービスであり、ローカルで並行利用すると競合し得る。 | workflow が今回編集禁止対象であるため。 |

## 設計判断

`verify-remote` の表示同期タイムアウトに対しては、通信のワイヤー形式・Rust 側の状態権威・既存の 12 秒と 18 秒のタイムアウト値を維持したまま、`deck-bridge` が 12 秒の期限内で一時的な `opacity: 0` を即エラーにせず再待機ループを継続し、`verify-remote` が ACK と新規 host error の双方を待つ方針を採用した。これにより Vue の再入場トランジションに伴う過渡的な透明状態で誤失敗せず、非表示が継続して表示へ至らない状態は `deck-bridge` 側の 12 秒の描画期限で失敗とし、検証側は失敗通知を受けた時点で 18 秒の ACK 待ちタイムアウトを待たずに検出できる。あわせて `verify` と `verify-library` の固定 sleep を実 DOM 条件や `opacity` の待機へ置き換え、常時表示設定を回避する viewport（`1440x810`）へ是正した。一方、実 registry を参照する packaged consumer 検証、タイムアウト契約テスト、否定観測用の短時間待機、および未再現のポート再 bind 競合などは、検査目的そのものを損なわないことと根拠のない延長・変更を避けることから今回は据え置いた。

## 未検証事項

- GitHub Actions 上での再実行、全量 `portable`、packed consumer、publication-jobs、`native` 回帰、およびクリーンコンテナ環境は未実行である。
- Rust・Tauri・WebKit、物理 2 画面構成、Windows、および外部クラウド環境は未検証であり、Chromium 上での protocol シミュレーション成功とは区別する必要がある。
- `pnpm check` でスキップされた PostgreSQL 統合テスト 9 件は成功扱いしない。
- 負荷試験は 1 CPU 制限下での `verify-remote.mjs` 3 回実行にとどまるため、CPU が CI 障害の唯一の要因であるとは断言できない。
