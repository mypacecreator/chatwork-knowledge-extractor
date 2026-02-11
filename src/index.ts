import dotenv from 'dotenv';
import { ChatworkClient } from './chatwork/client.js';
import { ClaudeAnalyzer, type AnalyzedMessage } from './claude/analyzer.js';
import { MarkdownFormatter } from './formatter/markdown.js';
import { JSONFormatter } from './formatter/json.js';
import { MessageCacheManager } from './cache/messages.js';
import { TeamProfileManager } from './team/profiles.js';
import { join } from 'path';

// 環境変数読み込み
dotenv.config();

async function main() {
  // コマンドライン引数チェック
  const args = process.argv.slice(2);
  const isReanalyze = args.includes('--reanalyze');

  console.log('=== Chatwork Knowledge Extractor ===\n');
  if (isReanalyze) {
    console.log('モード: 再出力（キャッシュから出力のみ、Claude API呼び出しなし）\n');
  }

  // 環境変数チェック
  const chatworkToken = process.env.CHATWORK_API_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;
  const claudeApiKey = process.env.CLAUDE_API_KEY;
  const outputDir = process.env.OUTPUT_DIR || './output';
  const maxMessages = parseInt(process.env.MAX_MESSAGES || '500');
  const promptTemplatePath = process.env.PROMPT_TEMPLATE_PATH;
  const feedbackPath = process.env.FEEDBACK_PATH;
  const teamProfilesPath = process.env.TEAM_PROFILES_PATH;
  const claudeModel = process.env.CLAUDE_MODEL;
  const outputVersatility = (process.env.OUTPUT_VERSATILITY || 'high,medium')
    .split(',')
    .map(v => v.trim());

  // EXTRACT_FROM: 日付形式（YYYY-MM-DD）または日数
  // 後方互換のためDAYS_TO_EXTRACTもサポート
  const extractFromRaw = process.env.EXTRACT_FROM || process.env.DAYS_TO_EXTRACT;

  // reanalyzeモードではClaude APIキーは不要
  if (!chatworkToken || !roomId) {
    console.error('エラー: CHATWORK_API_TOKEN, CHATWORK_ROOM_ID が設定されていません');
    console.error('.envファイルを確認してください');
    process.exit(1);
  }

  if (!isReanalyze && !claudeApiKey) {
    console.error('エラー: CLAUDE_API_KEY が設定されていません');
    console.error('.envファイルを確認してください');
    process.exit(1);
  }

  // 警告を収集
  const allWarnings: string[] = [];
  const cacheManager = new MessageCacheManager();
  const teamProfileManager = new TeamProfileManager(teamProfilesPath);

  try {
    let knowledgeItems: AnalyzedMessage[];
    let usedModel: string;

    if (isReanalyze) {
      // === 再出力モード: キャッシュから分析結果を読み込み ===
      console.log('[1/3] 分析結果キャッシュを読み込み中...\n');
      await cacheManager.showAnalysisStats(roomId);

      const cachedResults = await cacheManager.loadAnalysisResults(roomId);

      if (cachedResults.length === 0) {
        console.log('分析結果のキャッシュがありません。先に通常モードで実行してください。');
        return;
      }

      console.log(`キャッシュから${cachedResults.length}件の分析結果を読み込み\n`);

      // 期間フィルタ（キャッシュの分析結果にも適用）
      let filteredResults = cachedResults;
      if (extractFromRaw) {
        const beforeCount = filteredResults.length;
        filteredResults = filterAnalysisResultsByDate(filteredResults, extractFromRaw);
        console.log(`期間フィルタ適用: ${beforeCount}件 → ${filteredResults.length}件`);
      }

      // 汎用性フィルタ
      console.log(`汎用性フィルタ: ${outputVersatility.join(', ')} のみ出力`);
      knowledgeItems = filteredResults.filter(
        item => item.versatility !== 'exclude'
          && item.category !== '除外対象'
          && outputVersatility.includes(item.versatility)
      );

      // キャッシュからモデル情報を取得
      const analysisCache = await cacheManager.loadAnalysisCache(roomId);
      usedModel = analysisCache?.model || claudeModel || '(不明)';
      console.log(`分析モデル: ${usedModel}`);
      console.log(`フィルタ後: ${knowledgeItems.length}件が形式知化対象\n`);

    } else {
      // === 通常モード: 取得 → 分析 → 出力 ===
      console.log('[1/5] Chatworkメッセージ取得中...\n');
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
      const analyzedIds = await cacheManager.getAnalyzedIds(roomId);
      const unanalyzedMessages = cacheManager.getUnanalyzedMessages(messages, analyzedIds);

      console.log(`未分析メッセージ: ${unanalyzedMessages.length}件\n`);

      if (unanalyzedMessages.length === 0) {
        console.log('新しく分析するメッセージがありません。');
        console.log('キャッシュから再出力するには --reanalyze オプションを使ってください。');
        return;
      }

      // Step 2: Claude Batch APIで分析（未分析分のみ）
      console.log('[2/5] Claude Batch APIで分析中...\n');

      const analyzer = new ClaudeAnalyzer(claudeApiKey!, {
        promptTemplatePath,
        feedbackPath,
        model: claudeModel
      });
      usedModel = analyzer.getModel();
      console.log(`使用モデル: ${usedModel}`);
      console.log('※ バッチ処理のため、完了まで数分〜数十分かかります\n');

      const roleResolver = teamProfileManager.hasProfiles()
        ? (accountId: number) => teamProfileManager.resolveRole(accountId)
        : undefined;
      const analyzed = await analyzer.analyzeBatch(unanalyzedMessages, roleResolver);

      // 分析したメッセージIDを記録
      const newlyAnalyzedIds = unanalyzedMessages.map(m => m.message_id);
      await cacheManager.markAsAnalyzed(roomId, newlyAnalyzedIds);

      // 分析結果をキャッシュに保存（モデル情報付き）
      console.log('\n[3/5] 分析結果をキャッシュに保存中...\n');
      await cacheManager.saveAnalysisResults(roomId, analyzed, usedModel);

      // 既存キャッシュ + 新規分析結果をマージしてフィルタリング
      let allResults = await cacheManager.loadAnalysisResults(roomId);

      // 期間フィルタ（出力対象にも適用）
      if (extractFromRaw) {
        const beforeCount = allResults.length;
        allResults = filterAnalysisResultsByDate(allResults, extractFromRaw);
        console.log(`期間フィルタ適用（出力対象）: ${beforeCount}件 → ${allResults.length}件`);
      }

      console.log(`汎用性フィルタ: ${outputVersatility.join(', ')} のみ出力`);

      knowledgeItems = allResults.filter(
        item => item.versatility !== 'exclude'
          && item.category !== '除外対象'
          && outputVersatility.includes(item.versatility)
      );

      console.log(`分析完了: ${analyzed.length}件中、全体で ${knowledgeItems.length}件が形式知化対象\n`);
    }

    if (knowledgeItems.length === 0) {
      console.log('出力対象の知見がありません。');
      return;
    }

    // ルーム情報を取得（出力ファイル名生成用）
    const chatworkClient = new ChatworkClient(chatworkToken);
    const roomInfo = await chatworkClient.getRoomInfo(roomId);

    // 出力ファイル名生成
    const timestamp = new Date().toISOString()
      .replace(/:/g, '-')
      .replace(/\..+/, '')
      .replace('T', '_');
    const safeRoomName = roomInfo.name
      .replace(/[\/\\:*?"<>|]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 50);
    const baseFilename = `knowledge_${roomId}_${safeRoomName}_${timestamp}`;

    // フォーマットオプション
    const formatOptions = {
      roomName: roomInfo.name,
      roomId: roomId,
      model: usedModel
    };

    const stepPrefix = isReanalyze ? '[2/3]' : '[4/5]';
    const stepPrefix2 = isReanalyze ? '[3/3]' : '[5/5]';

    // === 内部用Markdown出力（発言者あり） ===
    console.log(`${stepPrefix} 内部用Markdown出力中（発言者あり）...\n`);
    const internalDir = join(outputDir, 'internal');
    const internalMdPath = join(internalDir, `${baseFilename}.md`);
    const markdownFormatter = new MarkdownFormatter();
    await markdownFormatter.format(knowledgeItems, internalMdPath, {
      ...formatOptions,
      anonymize: false
    });

    // === 外部用Markdown出力（匿名化） ===
    console.log(`\n${stepPrefix2} 外部用出力中（匿名化）...\n`);
    const externalDir = join(outputDir, 'external');
    const externalMdPath = join(externalDir, `${baseFilename}.md`);
    await markdownFormatter.format(knowledgeItems, externalMdPath, {
      ...formatOptions,
      anonymize: true
    });

    // === 外部用JSON出力（匿名化） ===
    const externalJsonPath = join(externalDir, `${baseFilename}.json`);
    const jsonFormatter = new JSONFormatter();
    await jsonFormatter.format(knowledgeItems, externalJsonPath, {
      ...formatOptions,
      anonymize: true
    });

    // 完了
    console.log('\n=== 完了 ===');
    console.log(`\n出力ファイル:`);
    console.log(`  [内部用・発言者あり]`);
    console.log(`  - ${internalMdPath}`);
    console.log(`  [外部用・匿名化済み]`);
    console.log(`  - ${externalMdPath}`);
    console.log(`  - ${externalJsonPath}`);
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

    // 汎用性レベル別集計
    const versatilityCount: Record<string, number> = {};
    for (const item of knowledgeItems) {
      versatilityCount[item.versatility] = (versatilityCount[item.versatility] || 0) + 1;
    }

    console.log('\n汎用性レベル別内訳:');
    for (const [level, count] of Object.entries(versatilityCount)) {
      console.log(`  ${level}: ${count}件`);
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

/**
 * 分析結果をEXTRACT_FROM形式で期間フィルタ
 * item.date（ISO文字列）を使って判定
 */
function filterAnalysisResultsByDate(results: AnalyzedMessage[], extractFrom: string): AnalyzedMessage[] {
  const dateMatch = extractFrom.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  let cutoffTime: number;
  if (dateMatch) {
    // YYYY-MM-DDをローカル日付の0時として解釈
    const [, year, month, day] = dateMatch;
    const fromDate = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
    cutoffTime = fromDate.getTime();
  } else {
    const days = parseInt(extractFrom, 10);
    if (isNaN(days)) {
      console.warn(`[警告] EXTRACT_FROM の形式が不正です: ${extractFrom}`);
      return results;
    }
    cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
  }

  return results.filter(item => {
    const itemTime = new Date(item.date).getTime();
    return itemTime >= cutoffTime;
  });
}

main();
