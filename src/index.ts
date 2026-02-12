import dotenv from 'dotenv';
import { ChatworkClient } from './chatwork/client.js';
import { ClaudeAnalyzer, type AnalyzedMessage } from './claude/analyzer.js';
import { MarkdownFormatter } from './formatter/markdown.js';
import { JSONFormatter } from './formatter/json.js';
import { MessageCacheManager } from './cache/messages.js';
import { TeamProfileManager } from './team/profiles.js';
import { filterMessages } from './utils/messageFilter.js';
import { join } from 'path';

// 環境変数読み込み
dotenv.config();

/**
 * 環境変数から正の整数をパース（基数10、NaN対策）
 * @param value 環境変数の値
 * @param defaultValue パース失敗時のデフォルト値
 * @returns パース結果（無効な値の場合はdefaultValue）
 */
function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

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

  // メッセージフィルタ設定（環境変数で上書き可能）
  const filterConfig = {
    minLength: parsePositiveInt(process.env.FILTER_MIN_LENGTH, 10),
    maxLength: parsePositiveInt(process.env.FILTER_MAX_LENGTH, 300),
    boilerplateThreshold: parsePositiveInt(process.env.FILTER_BOILERPLATE_THRESHOLD, 50),
  };

  // フィルタ設定のバリデーション
  if (filterConfig.minLength > filterConfig.maxLength) {
    console.warn(`警告: FILTER_MIN_LENGTH(${filterConfig.minLength}) > FILTER_MAX_LENGTH(${filterConfig.maxLength}). maxLengthをminLengthに合わせます`);
    filterConfig.maxLength = Math.max(filterConfig.minLength, filterConfig.maxLength);
  }

  // Claude API種別の選択
  const claudeApiMode = (process.env.CLAUDE_API_MODE || 'batch') as 'batch' | 'realtime';

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
  const teamProfileManager = !isReanalyze ? new TeamProfileManager(teamProfilesPath) : null;

  try {
    let knowledgeItems: AnalyzedMessage[];
    let usedModel = '';

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

      if (unanalyzedMessages.length > 0) {
        // メッセージの事前フィルタリング（知見が含まれない可能性が高いものを除外）
        console.log('事前フィルタリング中...');
        const { filtered: filteredMessages, stats } = filterMessages(unanalyzedMessages, filterConfig);
        console.log(`  - 対象: ${stats.total}件`);
        console.log(`  - スキップ: ${stats.skipped}件 (短すぎる/定型文)`);
        console.log(`  - 切り詰め: ${stats.truncated}件 (${filterConfig.maxLength}文字超)`);
        console.log(`  - API送信: ${filteredMessages.length}件\n`);

        if (stats.skipped > 0) {
          console.log('スキップ理由の内訳:');
          for (const [reason, count] of Object.entries(stats.reasons)) {
            console.log(`  - ${reason}: ${count}件`);
          }
          console.log('');
        }

        if (filteredMessages.length > 0) {
          // Step 2: Claude APIで分析（フィルタリング済みメッセージのみ）
          console.log('[2/5] Claude APIで分析中...\n');

          const analyzer = new ClaudeAnalyzer(claudeApiKey!, {
            promptTemplatePath,
            feedbackPath,
            model: claudeModel,
            apiMode: claudeApiMode
          });
          usedModel = analyzer.getModel();
          console.log(`使用モデル: ${usedModel}`);

          if (claudeApiMode === 'batch') {
            console.log('※ Batch API: 50%割引、処理時間は数分〜24時間\n');
          } else {
            console.log('※ Realtime API: 通常価格、処理時間は数秒〜数分\n');
          }

          const roleResolver = teamProfileManager!.hasProfiles()
              ? (accountId: number) => teamProfileManager!.resolveRole(accountId)
              : undefined;
          const analyzed = await analyzer.analyze(filteredMessages, roleResolver);

          // 分析したメッセージIDを記録（フィルタリング済みメッセージのみ）
          const newlyAnalyzedIds = filteredMessages.map(m => m.message_id);
          await cacheManager.markAsAnalyzed(roomId, newlyAnalyzedIds);

          // 分析結果をキャッシュに保存（モデル情報付き）
          console.log('\n[3/5] 分析結果をキャッシュに保存中...\n');
          await cacheManager.saveAnalysisResults(roomId, analyzed, usedModel);
        } else {
          console.log('フィルタリング後、新規の分析対象メッセージはありません。キャッシュがあれば出力します。\n');
        }
      } else {
        console.log('新しく分析するメッセージはありません。キャッシュがあれば出力します。\n');
      }

      // 既存キャッシュから分析結果を読み込み
      let allResults = await cacheManager.loadAnalysisResults(roomId);

      // 期間フィルタ（出力対象にも適用）
      if (extractFromRaw) {
        const beforeCount = allResults.length;
        allResults = filterAnalysisResultsByDate(allResults, extractFromRaw);
        console.log(`期間フィルタ適用（出力対象）: ${beforeCount}件 → ${allResults.length}件`);
      }

      console.log(`汎用性フィルタ: ${outputVersatility.join(', ')} のみ出力`);
      console.log(`[Debug] フィルタリング前: ${allResults.length}件`);

      // デバッグ: versatility分布を表示
      const versatilityDist = allResults.reduce((acc, item) => {
        acc[item.versatility] = (acc[item.versatility] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log(`[Debug] versatility分布:`, versatilityDist);

      knowledgeItems = allResults.filter(
          item => item.versatility !== 'exclude'
              && item.category !== '除外対象'
              && outputVersatility.includes(item.versatility)
      );

      console.log(`[Debug] フィルタリング後: ${knowledgeItems.length}件`);

      // usedModelがまだ設定されていない場合（新規分析なし）、キャッシュから取得
      if (!usedModel) {
        const analysisCache = await cacheManager.loadAnalysisCache(roomId);
        usedModel = analysisCache?.model || claudeModel || '(不明)';
      }

      console.log(`全体で ${knowledgeItems.length}件が形式知化対象\n`);
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
