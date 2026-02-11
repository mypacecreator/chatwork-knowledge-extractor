# Chatwork Knowledge Extractor

Chatworkのチャット履歴から形式知化できる知見を自動抽出し、マークダウンとJSONで出力するツールです。

## 特徴

- Chatwork APIでメッセージを取得
- Claude AI (Batch API) で知見を分析・分類
- 汎用性の判定とタグ付けを自動化
- **内部用Markdown**（発言者あり・レビュー用）と**外部用Markdown+JSON**（匿名化済み・共有用）の2段階出力
- 低コスト（Batch API利用で50%割引）
- **分析結果キャッシュ**で再出力時のClaude API呼び出しゼロ
- **定期実行でメッセージを蓄積**（100件以上の履歴を保存可能）
- **チームプロファイル**で発言者のロール（senior/junior）に応じた重み付け分析

---

## セットアップ

### 1. インストール

```bash
npm install
```

### 2. 環境変数設定

`.env.example` をコピーして `.env` を作成し、必要な情報を入力：

```bash
cp .env.example .env
```

`.env` の内容：

```env
CHATWORK_API_TOKEN=your_chatwork_api_token
CHATWORK_ROOM_ID=your_room_id
CLAUDE_API_KEY=your_claude_api_key
EXTRACT_FROM=90
MAX_MESSAGES=500
OUTPUT_DIR=./output
```

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `CHATWORK_API_TOKEN` | ✅ | Chatwork APIトークン |
| `CHATWORK_ROOM_ID` | ✅ | 対象ルームID |
| `CLAUDE_API_KEY` | ✅ | Claude APIキー |
| `CLAUDE_MODEL` | - | 使用するClaudeモデル。デフォルト`claude-sonnet-4-5-20250929` |
| `EXTRACT_FROM` | - | 分析対象期間。数字なら過去N日、日付（2025-01-01）ならその日以降 |
| `MAX_MESSAGES` | - | 分析対象の最大件数。デフォルト500 |
| `OUTPUT_DIR` | - | 出力先ディレクトリ。デフォルト`./output` |
| `OUTPUT_VERSATILITY` | - | 出力する汎用性レベル。デフォルト`high,medium` |
| `PROMPT_TEMPLATE_PATH` | - | カスタムプロンプトのパス。デフォルト`prompts/analysis.md` |
| `FEEDBACK_PATH` | - | フィードバックファイルのパス。デフォルト`feedback/corrections.json` |
| `TEAM_PROFILES_PATH` | - | チームプロファイルのパス。デフォルト`config/team-profiles.json` |
| `FILTER_MIN_LENGTH` | - | メッセージ最小文字数（これ未満は除外）。デフォルト`5` |
| `FILTER_MAX_LENGTH` | - | メッセージ最大文字数（超過分は切り詰め）。デフォルト`500` |

**利用可能なモデル一覧:** https://platform.claude.com/docs/ja/about-claude/models/overview

### 3. APIトークンの取得

**Chatwork APIトークン:**
1. Chatworkにログイン
2. 右上のユーザー名 → 「サービス連携」→「API Token」
3. トークンを発行・コピー

**ルームID:**
- チャットを開いた時のURL `https://www.chatwork.com/#!rid123456` の `123456` 部分

**Claude APIキー:**
1. https://console.anthropic.com/ にアクセス
2. APIキーを発行

---

## 使い方

### 基本的な実行（通常モード）

```bash
# ビルド
npm run build

# 実行
npm start
```

開発モード（TypeScriptを直接実行）：

```bash
npm run dev
```

### 再出力モード（`--reanalyze`）

キャッシュ済みの分析結果から、Claude APIを呼ばずに出力だけを再生成します。
`OUTPUT_VERSATILITY`の変更を試したい場合や、出力形式を確認したい場合に便利です。

```bash
# ビルド済みの場合
npm run reanalyze

# 開発モード
npm run dev:reanalyze
```

### 実行の流れ（通常モード）

```
=== Chatwork Knowledge Extractor ===

[1/5] Chatworkメッセージ取得中...
[Cache] 統計情報:
  - 保存件数: 150件
  - 最古: 2024/11/15 10:30:00
  - 最新: 2025/02/09 15:45:00
[Chatwork] 差分取得: キャッシュに150件あり
[Chatwork] API取得: 5件（新規メッセージ）

[2/5] Claude Batch APIで分析中...
※ バッチ処理のため、完了まで数分〜数十分かかります

[3/5] 分析結果をキャッシュに保存中...

[4/5] 内部用Markdown出力中（発言者あり）...
[5/5] 外部用出力中（匿名化）...

=== 完了 ===

出力ファイル:
  [内部用・発言者あり]
  - ./output/internal/knowledge_123456_ルーム名_2025-02-09_15-30-00.md
  [外部用・匿名化済み]
  - ./output/external/knowledge_123456_ルーム名_2025-02-09_15-30-00.md
  - ./output/external/knowledge_123456_ルーム名_2025-02-09_15-30-00.json
```

---

## メッセージフィルタリング（パフォーマンス最適化）

Claude APIへのリクエスト前に、明らかに知見が含まれないメッセージを自動除外します。
これにより、**処理時間の短縮**と**コスト削減**を実現します。

### 除外されるメッセージ

- **短すぎるメッセージ**（デフォルト: 5文字未満）
  - 例: `!`, `w`, `OK`
- **定型文**（正規表現マッチング）
  - 例: `了解です`, `承知しました`, `お疲れ様です`, `よろしくお願いします`
- **記号のみのメッセージ**
  - 例: `!!!`, `👍`, `🙏`

### 切り詰め処理

- **長すぎるメッセージ**（デフォルト: 500文字超）は、500文字で切り詰め
- 文の途中で切れないよう、句点・改行で自動調整

### 設定方法

`.env` で調整可能：

```env
# 5文字未満は除外（デフォルト: 5）
FILTER_MIN_LENGTH=5

# 500文字超は切り詰め（デフォルト: 500）
FILTER_MAX_LENGTH=500
```

### 実行時の出力例

```
事前フィルタリング中...
  - 対象: 150件
  - スキップ: 45件 (短すぎる/定型文)
  - 切り詰め: 8件 (500文字超)
  - API送信: 105件

スキップ理由の内訳:
  - too_short (3 chars): 20件
  - matched_pattern: ^了解(です|しました)?[!！。]*$: 15件
  - matched_pattern: ^お疲れ様です[!！。]*$: 10件
```

### 効果

| 項目 | 改善率 |
|------|--------|
| API送信データ量 | **30-50%削減** |
| 処理時間 | **30-40%短縮** |
| コスト | **30-50%削減** |

---

## 定期実行（推奨）

### Chatwork APIの制限について

Chatwork APIは**1回のリクエストで最新100件まで**しか取得できません。
古いメッセージを遡って取得するAPIは存在しないため、**定期的に実行してメッセージを蓄積する**運用が必要です。

### 仕組み

```
[初回実行]
  → 最新100件を取得
  → cache/room_{roomId}.json に保存

[2回目以降]
  → キャッシュを読み込み
  → 前回取得以降の新規メッセージのみ取得
  → キャッシュにマージして保存
  → 蓄積されたメッセージ全体を分析
```

### 推奨スケジュール

| 用途 | 頻度 | 説明 |
|------|------|------|
| 日常的な蓄積 | 週1回 | メッセージを取りこぼさないための定期実行 |
| 案件終了時 | 随時 | 振り返りのタイミングで実行 |
| 中間振り返り | 月1回 | 進行中案件の知見整理 |

### cron設定例（毎週月曜9時に実行）

```bash
0 9 * * 1 cd /path/to/chatwork-knowledge-extractor && npm start >> logs/cron.log 2>&1
```

---

## 出力ファイル

`output/` ディレクトリに**内部用**と**外部用**の2種類が生成されます：

```
output/
├── internal/          # 内部用（発言者あり・レビュー用）
│   └── knowledge_*.md
└── external/          # 外部用（匿名化済み・共有用）
    ├── knowledge_*.md
    └── knowledge_*.json
```

| 出力先 | 形式 | 発言者名 | 用途 |
|--------|------|---------|------|
| `output/internal/` | Markdown | 実名 | チーム内レビュー・振り返り |
| `output/external/` | Markdown + JSON | 匿名化（「発言者1」等） | 社外共有・AI二次利用 |

### 内部用Markdown（発言者あり）

チーム内レビュー向け。誰がどの知見を共有したか確認できます：

```markdown
### [汎用性: high] トレイリングスラッシュの統一ルール

- **発言者**: 野村 圭
- **日時**: 2025/2/7 6:54:40
- **タグ**: `URL設計`, `SEO`, `コーディング規約`

サイト内のリンクURLにトレイリングスラッシュの有無を統一すること...
```

### 外部用Markdown / JSON（匿名化済み）

NotebookLMや他の生成AIでの二次利用、社外共有向け。発言者名は自動匿名化されます：

```json
{
  "export_date": "2025-02-09T15:30:00.000Z",
  "total_items": 25,
  "items": [
    {
      "message_id": "2071739886704263168",
      "category": "制作方針・指示出し",
      "versatility": "high",
      "title": "トレイリングスラッシュの統一ルール",
      "tags": ["URL設計", "SEO", "コーディング規約"],
      "speaker": "発言者1",
      "date": "2025-02-07T06:54:40.000Z",
      "formatted_content": "サイト内のリンクURLに..."
    }
  ]
}
```

---

## キャッシュ管理

### キャッシュファイルの場所

```
cache/
├── room_{roomId}.json         # メッセージキャッシュ（Chatwork APIレスポンス）
└── analysis_{roomId}.json     # 分析結果キャッシュ（Claude API分析済みデータ）
```

| ファイル | 内容 | 用途 |
|---------|------|------|
| `room_*.json` | 生メッセージ + 分析済みID | Chatwork API呼び出しの削減 |
| `analysis_*.json` | 分析結果（AnalyzedMessage[]） | `--reanalyze`での再出力、Claude API呼び出しの削減 |

### キャッシュの確認

実行時に統計情報が表示されます：

```
[Cache] 統計情報:
  - 保存件数: 150件
  - 最終更新: 2025-02-09T06:30:00.000Z
  - 最古: 2024/11/15 10:30:00
  - 最新: 2025/02/09 15:45:00
[Cache] 分析結果キャッシュ: 120件
```

### キャッシュのリセット

最初からやり直したい場合は、キャッシュファイルを削除してください：

```bash
# メッセージキャッシュのみリセット（APIからの再取得が必要になる）
rm cache/room_*.json

# 分析結果キャッシュのみリセット（Claude APIでの再分析が必要になる）
rm cache/analysis_*.json

# すべてリセット
rm cache/*.json
```

---

## カテゴリと汎用性

### カテゴリ一覧

| カテゴリ | 説明 | 出力対象 |
|----------|------|----------|
| 実装ノウハウ | コーディング、WordPress、ECサイト関連の技術的知見 | ✅ |
| 制作方針・指示出し | 実装や制作の方針に関する普遍的な知見 | ✅ |
| トラブル対応 | エラー解決、不具合対処の汎用的な方法 | ✅ |
| 質疑応答・相談 | 判断基準、仕様確認の汎用的なパターン | ✅ |
| 除外対象 | 案件固有の内容、挨拶、スケジュール調整など | ❌（除外） |

### 汎用性レベル（4段階）

| レベル | 説明 | 例 |
|--------|------|-----|
| high | 普遍的な技術知見（どの案件でも活用可能） | 「WP_DEBUGは本番でfalseにする」 |
| medium | 業界・技術領域特有の知見 | 「不動産サイトではGoogleマップ埋め込みが必須」 |
| low | ケースバイケースだが参考になる判断例 | 「素材未確定時はダミーで仮配置」 |
| exclude | 案件固有・定型文（出力から除外） | 「メインカラーは#3498db」「了解しました」 |

`OUTPUT_VERSATILITY` 環境変数で出力対象を制御できます：

```env
OUTPUT_VERSATILITY=high           # 厳格（普遍的知見のみ）
OUTPUT_VERSATILITY=high,medium    # 推奨（デフォルト）
OUTPUT_VERSATILITY=high,medium,low # すべて含む
```

---

## プライバシー・機密情報の保護

出力データに機密情報や個人情報が含まれないよう、複数の対策を組み合わせています。

### プロンプトによるPII除去

分析プロンプトにて、`formatted_content`（整形後テキスト）から以下の情報を除去・一般化するようClaude AIに指示しています：

- 個人名・担当者名（「田中さんが」→「担当者が」）
- メールアドレス・電話番号・住所
- 社名・クライアント名・案件名
- URL・IPアドレス・ドメイン名（技術解説用の一般的な例は除く）
- パスワード・APIキー・トークン等の認証情報
- 社内システムのパス・内部サーバー名
- 金額・見積もり・契約に関する具体的数値

### 生データの出力除外

元のチャットメッセージ本文（`original_body`）は出力ファイルに含まれません。出力されるのはClaude AIが整形・匿名化済みの`formatted_content`のみです。

### 発言者名の自動匿名化（2段階出力）

出力は**内部用**（発言者あり）と**外部用**（匿名化済み）に分かれています：

- `output/internal/` - 発言者名がそのまま出力（チーム内レビュー用）
- `output/external/` - 発言者名が「発言者1」「発言者2」等に自動変換（共有・AI二次利用用）

外部用出力のみを共有すれば、発言者のプライバシーを保護できます。

### その他の保護

- APIトークン・キー等は`.env`に保存され、`.gitignore`で除外済み
- キャッシュファイル（`cache/`）と出力ファイル（`output/`）もリポジトリに含まれません

---

## フィードバックによる精度改善

汎用性レベルの判定精度を継続的に改善できます。

### 仕組み

1. 出力結果を確認し、誤判定を見つける
2. `feedback/corrections.json` に修正例を追加
3. 次回実行時、修正例がプロンプトに自動注入される

### フィードバックファイルの作成

```bash
cp feedback/corrections.example.json feedback/corrections.json
```

### フィードバックの記述例

```json
[
  {
    "example": "レスポンシブはモバイルファーストで実装する",
    "wrong_level": "medium",
    "correct_level": "high",
    "reason": "技術原則として普遍的に適用できる"
  },
  {
    "example": "A社のロゴは左上に配置",
    "wrong_level": "low",
    "correct_level": "exclude",
    "reason": "完全に案件固有の指示"
  }
]
```

| フィールド | 説明 |
|-----------|------|
| `example` | 誤判定されたメッセージの内容（または要約） |
| `wrong_level` | AIが誤って判定したレベル |
| `correct_level` | 正しいレベル |
| `reason` | なぜそのレベルが正しいかの理由 |

フィードバックを蓄積していくことで、チーム固有の判断基準をAIに学習させることができます。

---

## チームプロファイル（発言者ロールによる重み付け）

チームメンバーの役割（senior/member/junior）を設定すると、AIが発言者の経験レベルに応じて分析の重み付けを自動調整します。

### セットアップ

```bash
cp config/team-profiles.example.json config/team-profiles.json
```

`config/team-profiles.json` にChatworkの `account_id` とロールの対応を記述します：

```json
{
  "profiles": {
    "12345": {
      "name": "山田太郎",
      "role": "senior"
    },
    "67890": {
      "name": "佐藤花子",
      "role": "junior"
    }
  }
}
```

### ロール別の分析動作

| ロール | 分析方針 | 説明 |
|--------|----------|------|
| `senior` | 標準（Standard）として扱う | 汎用性を高く見積もり、背景の原則を深く掘り下げる |
| `member` | 通常の分析（追加指示なし） | デフォルト。未登録ユーザーもこの扱い |
| `junior` | 事例（Case Study）として扱う | 技術的な正確性を厳しく検証し、汎用性を低めに判定 |

### account_id の確認方法

Chatwork APIでルームメンバーを取得して確認できます：

```bash
curl -H "X-ChatWorkToken: YOUR_TOKEN" \
  "https://api.chatwork.com/v2/rooms/YOUR_ROOM_ID/members"
```

### 注意事項

- プロファイル未設定（ファイルなし）の場合、全員 `member` として従来通り分析されます
- 分析結果の `speaker_role` フィールドに適用されたロールが記録されます

---

## コスト目安

Claude Batch APIは通常APIの**50%割引**が適用されます。

| メッセージ数 | 概算コスト |
|-------------|-----------|
| 100件 | $0.3〜0.5 |
| 500件 | $1.5〜2.5 |
| 1000件 | $3〜5 |

※ メッセージの長さにより変動します

---

## トラブルシューティング

### 「メッセージがありません」と表示される

- Chatworkルームにメッセージが存在するか確認
- `CHATWORK_ROOM_ID` が正しいか確認
- APIトークンに対象ルームへのアクセス権があるか確認

### Batch処理が長時間かかる

Claude Batch APIは非同期処理のため、数分〜数十分かかることがあります。
これは正常な動作です。

### 差分取得で0件になる

前回実行以降に新しいメッセージがない場合は正常です。
キャッシュされた既存メッセージは引き続き分析対象になります。

### キャッシュが壊れた場合

```bash
rm cache/room_*.json
```

でキャッシュを削除し、再実行してください。

---

## ライセンス

MIT
