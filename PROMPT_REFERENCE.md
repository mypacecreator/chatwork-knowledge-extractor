# Claude API プロンプト（改善版）

## 汎用性4段階判定のためのプロンプト

以下のプロンプトを `src/claude/analyzer.ts` の `createAnalysisPrompt()` メソッドに実装してください。

```typescript
private createAnalysisPrompt(message: ChatworkMessage): string {
  return `あなたはWeb制作チームのチャット履歴から**汎用的な**形式知を抽出するアシスタントです。

【重要】案件固有の内容は除外し、他の案件でも活用できる知見のみを抽出してください。

以下のメッセージを分析し、JSON形式で結果を返してください。

【メッセージ】
発言者: ${message.account.name}
日時: ${new Date(message.send_time * 1000).toISOString()}
内容: ${message.body}

【分析指示】

1. カテゴリを以下から選択:
   - "実装ノウハウ": コーディング、WordPress、ECサイト関連の技術的知見
   - "制作方針・指示出し": 実装や制作の方針に関する普遍的な知見
   - "トラブル対応": エラー解決、不具合対処の汎用的な方法
   - "質疑応答・相談": 判断基準、仕様確認の汎用的なパターン
   - "除外対象": 上記に該当しない、または案件固有の内容

2. 汎用性を**4段階で厳格に**判定:

   **high** - 普遍的な技術知見（どの案件でも確実に活用可能）
   例1: "WordPressの本番環境では、WP_DEBUGをfalseに設定し、デバッグログを無効化する"
   例2: "CSSアニメーションではtransformを使うとrepaintを発生させないため高速"
   例3: "画像の遅延読み込みはloading='lazy'属性で実装できる"
   例4: "titleタグは28-32文字程度に収めると検索結果で省略されにくい"
   ※技術的理由や原則が明確で、どの案件でも応用できる

   **medium** - 業界・技術領域特有の知見
   例1: "不動産サイトでは物件詳細ページにGoogleマップ埋め込みが必須"
   例2: "BtoB製造業サイトでは製品カタログPDFダウンロード機能が重視される"
   例3: "飲食店サイトのメニューはスクロール式の方がモバイルで使いやすい"
   例4: "WordPressでECサイトを構築する場合、WooCommerceとWelcartで機能差がある"
   ※特定の業界・用途でのパターンや傾向

   **low** - ケースバイケースだが参考になる判断例
   例1: "クライアントが気に入っている競合サイトの雰囲気は、デザイン提案に反映すべき"
   例2: "人物写真が少ないと感じた場合、集合写真を1-2枚追加すると親しみやすさが増す"
   例3: "素材が未確定の段階では、ダミーで仮配置し、確定後に調整する"
   例4: "認証ロゴは追加される可能性があるため、柔軟に対応できる設計にする"
   ※案件ごとに状況は異なるが、判断の参考になる

   **exclude** - 案件固有の指示・定型文（カテゴリを「除外対象」に設定）
   例1: "トップページのヒーローエリアは高さ600pxで固定"
   例2: "メインカラーは#3498db、サブカラーは#e74c3c"
   例3: "ロゴサイズは横200px、縦60px"
   例4: "了解しました。対応します"
   例5: "確認お願いします"
   例6: "明日14時の打ち合わせで大丈夫ですか？"
   ※具体的な数値、色、固有名詞を含む個別指示、または挨拶・確認などの定型文

【判定の鉄則】
- 具体的な数値・色コード・固有名詞が中心 → exclude
- 「この案件では」「今回は」という限定表現 → exclude  
- 挨拶・確認・スケジュール調整 → exclude
- 技術的理由や原則の説明がある → high
- 業界特有のパターン・傾向 → medium
- 状況判断の考え方・アプローチ → low

3. タグを自動生成（技術名、業務タイプなど、3-5個程度）
   ※標準的な技術用語を使用（WordPress、CSS、JavaScript、SEO、デザインレビューなど）

4. タイトルを生成（簡潔に、20文字以内）

5. 内容を整形:
   - 案件固有の要素（案件名、クライアント名等）を削除または一般化
   - 文脈依存を排除し、単独で理解できる形に
   - 「これ」「それ」などの指示語を具体的な名詞に置き換え
   - 前提条件や背景も補足

【出力形式】
以下のJSON形式で返してください。それ以外は一切出力しないでください。

{
  "message_id": "${message.message_id}",
  "category": "カテゴリ名",
  "versatility": "high/medium/low/exclude",
  "title": "タイトル",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "speaker": "${message.account.name}",
  "date": "${new Date(message.send_time * 1000).toISOString()}",
  "formatted_content": "整形後の内容",
  "original_body": "${message.body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
}`;
}
```

## フィルタリングロジック

`src/index.ts` に以下を実装:

```typescript
// 環境変数読み込み
const outputVersatility = (process.env.OUTPUT_VERSATILITY || 'high,medium')
  .split(',')
  .map(v => v.trim());

console.log(`汎用性フィルタ: ${outputVersatility.join(', ')} のみ出力\n`);

// excludeを除外し、指定されたレベルのみ抽出
const knowledgeItems = analyzed.filter(
  item => item.versatility !== 'exclude' 
    && outputVersatility.includes(item.versatility)
);

console.log(`\n分析完了: ${analyzed.length}件中 ${knowledgeItems.length}件が形式知化対象\n`);

// カテゴリ別集計（excludeは含めない）
const categoryCount: Record<string, number> = {};
for (const item of knowledgeItems) {
  categoryCount[item.category] = (categoryCount[item.category] || 0) + 1;
}

console.log('カテゴリ別内訳:');
for (const [category, count] of Object.entries(categoryCount)) {
  console.log(`  ${category}: ${count}件`);
}

// 汎用性レベル別集計
const versatilityCount: Record<string, number> = {};
for (const item of knowledgeItems) {
  versatilityCount[item.versatility] = (versatilityCount[item.versatility] || 0) + 1;
}

console.log('\n汎用性レベル別内訳:');
for (const [level, count] of Object.entries(versatilityCount)) {
  console.log(`  ${level}: ${count}件`);
}
```

## 環境変数

`.env.example` と `.env` に追加:

```env
# 出力する汎用性レベル（high, medium, low をカンマ区切り）
# デフォルト: high,medium
# - high のみ: 最も厳格（普遍的な技術知見のみ）
# - high,medium: 推奨（業界特有の知見も含む）
# - high,medium,low: すべて（判断例も含む）
OUTPUT_VERSATILITY=high,medium
```
