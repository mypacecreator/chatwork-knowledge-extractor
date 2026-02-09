# Chatwork Knowledge Extractor

Chatworkのチャット履歴から形式知化できる知見を自動抽出し、マークダウンとJSONで出力するツールです。

## 特徴

- Chatwork APIでメッセージを取得
- Claude AI (Batch API) で知見を分析・分類
- 汎用性の判定とタグ付けを自動化
- Markdown（人間向け）とJSON（機械処理用）の両形式で出力
- 低コスト（Batch API利用で50%割引）

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
DAYS_TO_EXTRACT=90
MAX_MESSAGES=500
OUTPUT_DIR=./output
```

### 3. APIトークンの取得

**Chatwork APIトークン:**
1. Chatworkにログイン
2. 右上のユーザー名 → 「API設定」
3. トークンを発行・コピー

**ルームID:**
- チャットを開いた時のURL `https://www.chatwork.com/#!rid123456` の `123456` 部分

**Claude APIキー:**
1. https://console.anthropic.com/ にアクセス
2. APIキーを発行

## 使い方

### ビルド

```bash
npm run build
```

### 実行

```bash
npm start
```

または開発モード（TypeScriptを直接実行）：

```bash
npm run dev
```

## 出力

`output/` ディレクトリに以下のファイルが生成されます：

- `knowledge_YYYYMMDD_HHMMSS.md` - Markdown形式の知見まとめ
- `knowledge_YYYYMMDD_HHMMSS.json` - JSON形式のデータ

### Markdown形式

フロントマター付きで、後から編集可能：

```markdown
---
category: 実装ノウハウ
versatility: high
tags: [WordPress, カスタム投稿タイプ]
speaker: 山田
date: 2025-01-15
---
# WordPressカスタム投稿タイプのアーカイブ設定

カスタム投稿タイプでアーカイブページが表示されない場合...
```

### JSON形式

NotebookLMや他の生成AIで二次利用可能：

```json
{
  "export_date": "2025-02-06",
  "items": [
    {
      "category": "実装ノウハウ",
      "versatility": "high",
      "title": "...",
      "tags": ["WordPress"],
      "content": "..."
    }
  ]
}
```

## 仕組み

1. Chatwork APIでメッセージを取得（100件ずつページネーション）
2. Claude Batch APIでメッセージを分析
   - カテゴリ分類
   - 汎用性判定（high/medium/low）
   - タグ自動生成
   - 文脈依存を除去して単独で完結する形に整形
3. MarkdownとJSONで出力

## カテゴリ

- **実装ノウハウ** - コーディング、WordPress、ECサイト関連
- **制作方針・指示出し** - 汎用性判定付き
- **トラブル対応** - エラー解決、不具合対処
- **質疑応答・相談** - 判断基準、仕様確認
- **定型的なやりとり** - 挨拶、スケジュール調整など

## ライセンス

MIT
