import dotenv from 'dotenv';
import { ChatworkClient } from './chatwork/client.js';
import { ClaudeAnalyzer } from './claude/analyzer.js';
import { MarkdownFormatter } from './formatter/markdown.js';
import { JSONFormatter } from './formatter/json.js';
import { MessageCacheManager } from './cache/messages.js';
import { join } from 'path';

// 環境変数読み込み
dotenv.config();

async function main() {
  console.log('=== Chatwork Knowledge Extractor ===\n');

  // 環境変数チェック
  const chatworkToken = process.env.CHATWORK_API_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;
  const claudeApiKey = process.env.CLAUDE_API_KEY;
  const outputDir = process.env.OUTPUT_DIR || './output';
  const maxMessages = parseInt(process.env.MAX_MESSAGES || '500');

  // EXTRACT_FROM: 日付形式（YYYY-MM-DD）または日数
  // 後方互換のためDAYS_TO_EXTRACTもサポート
  const extractFromRaw = process.env.EXTRACT_FROM || process.env.DAYS_TO_EXTRACT;

  if (!chatworkToken || !roomId || !claudeApiKey) {
    console.error('エラー: 環境変数が設定されていません');
    console.error('.envファイルを確認してください');
    process.exit(1);
  }

  // 警告を収集
  const allWarnings: string[] = [];

  try {
    // Step 1: Chatworkからメッセージ取得
    console.log('[1/4] Chatworkメッセージ取得中...\n');
    const chatworkClient = new ChatworkClient(chatworkToken);

    // ルーム情報を取得
    const roomInfo = await chatworkClient.getRoomInfo(roomId);
    console.log(`対象ルーム: ${roomInfo.name} (ID: ${roomId})\n`);

    const fetchResult = await chatworkClient.getAllMessages(roomId, maxMessages);
    let messages = fetchResult.messages;

    // 警告を収集
    allWarnings.push(...fetchResult.warnings);

    console.log(`取得完了: ${messages.length}件\n`);

    // 期間フィルタ
    if (extractFromRaw) {
      const { messages: filtered, description } = chatworkClient.filterByExtractFrom(messages, extractFromRaw);
      messages = filtered;
      console.log(`期間フィルタ適用（${description}）: ${messages.length}件\n`);
    }

    if (messages.length === 0) {
      console.log('メッセージがありません。処理を終了します。');
      return;
    }

    // 未分析メッセージを抽出
    const cacheManager = new MessageCacheManager();
    const analyzedIds = await cacheManager.getAnalyzedIds(roomId);
    const unanalyzedMessages = cacheManager.getUnanalyzedMessages(messages, analyzedIds);

    console.log(`未分析メッセージ: ${unanalyzedMessages.length}件\n`);

    if (unanalyzedMessages.length === 0) {
      console.log('新しく分析するメッセージがありません。処理を終了します。');
      return;
    }

    // Step 2: Claude Batch APIで分析（未分析分のみ）
    console.log('[2/4] Claude Batch APIで分析中...\n');
    console.log('※ バッチ処理のため、完了まで数分〜数十分かかります\n');

    const analyzer = new ClaudeAnalyzer(claudeApiKey);
    const analyzed = await analyzer.analyzeBatch(unanalyzedMessages);

    // 分析したメッセージIDを記録
    const newlyAnalyzedIds = unanalyzedMessages.map(m => m.message_id);
    await cacheManager.markAsAnalyzed(roomId, newlyAnalyzedIds);

    // 定型的なやりとりを除外
    const knowledgeItems = analyzed.filter(
      item => item.category !== '定型的なやりとり'
    );

    console.log(`\n分析完了: ${analyzed.length}件中 ${knowledgeItems.length}件が形式知化対象\n`);

    // Step 3: 出力ファイル名生成
    const timestamp = new Date().toISOString()
      .replace(/:/g, '-')
      .replace(/\..+/, '')
      .replace('T', '_');
    const baseFilename = `knowledge_${timestamp}`;

    // フォーマットオプション
    const formatOptions = {
      roomName: roomInfo.name,
      roomId: roomId
    };

    // Step 4: Markdown出力
    console.log('[3/4] Markdown出力中...\n');
    const markdownPath = join(outputDir, `${baseFilename}.md`);
    const markdownFormatter = new MarkdownFormatter();
    await markdownFormatter.format(knowledgeItems, markdownPath, formatOptions);

    // Step 5: JSON出力
    console.log('\n[4/4] JSON出力中...\n');
    const jsonPath = join(outputDir, `${baseFilename}.json`);
    const jsonFormatter = new JSONFormatter();
    await jsonFormatter.format(knowledgeItems, jsonPath, formatOptions);

    // 完了
    console.log('\n=== 完了 ===');
    console.log(`\n出力ファイル:`);
    console.log(`  - ${markdownPath}`);
    console.log(`  - ${jsonPath}`);
    console.log(`\n形式知化された知見: ${knowledgeItems.length}件`);

    // カテゴリ別集計
    const categoryCount: Record<string, number> = {};
    for (const item of knowledgeItems) {
      categoryCount[item.category] = (categoryCount[item.category] || 0) + 1;
    }
    
    console.log('\nカテゴリ別内訳:');
    for (const [category, count] of Object.entries(categoryCount)) {
      console.log(`  ${category}: ${count}件`);
    }

    // 警告があれば表示
    if (allWarnings.length > 0) {
      console.log('\n=== 警告 ===\n');
      for (const warning of allWarnings) {
        console.log(warning);
        console.log('');
      }
    }

  } catch (error) {
    console.error('\nエラーが発生しました:');
    console.error(error);
    process.exit(1);
  }
}

main();
