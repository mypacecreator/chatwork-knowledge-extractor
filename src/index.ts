import dotenv from 'dotenv';
import { ChatworkClient } from './chatwork/client.js';
import { ClaudeAnalyzer, type AnalyzedMessage } from './claude/analyzer.js';
import { MarkdownFormatter } from './formatter/markdown.js';
import { JSONFormatter } from './formatter/json.js';
import { MessageCacheManager } from './cache/messages.js';
import { SpeakerMapManager } from './cache/speakerMap.js';
import { TeamProfileManager } from './team/profiles.js';
import { filterMessages } from './utils/messageFilter.js';
import { Logger } from './utils/logger.js';
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
  const logger = new Logger('Main');

  // コマンドライン引数チェック
  const args = process.argv.slice(2);
  const isReanalyze = args.includes('--reanalyze');

  logger.info('=== Chatwork Knowledge Extractor ===\n');
  if (isReanalyze) {
    logger.info('モード: 再出力（キャッシュから出力のみ、Claude API呼び出しなし）\n');
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
  const extractFromRaw = process.env.EXTRACT_FROM;

  // メッセージフィルタ設定（環境変数で上書き可能）
  const filterConfig = {
    minLength: parsePositiveInt(process.env.FILTER_MIN_LENGTH, 10),
    maxLength: parsePositiveInt(process.env.FILTER_MAX_LENGTH, 300),
    boilerplateThreshold: parsePositiveInt(process.env.FILTER_BOILERPLATE_THRESHOLD, 50),
  };

  // フィルタ設定のバリデーション
  if (filterConfig.minLength > filterConfig.maxLength) {
    logger.warn(`警告: FILTER_MIN_LENGTH(${filterConfig.minLength}) > FILTER_MAX_LENGTH(${filterConfig.maxLength}). maxLengthをminLengthに合わせます`);
    filterConfig.maxLength = Math.max(filterConfig.minLength, filterConfig.maxLength);
  }

  // Claude API種別の選択
  const claudeApiMode = (process.env.CLAUDE_API_MODE || 'batch') as 'batch' | 'realtime';

  // reanalyzeモードではClaude APIキーは不要
  if (!chatworkToken || !roomId) {
    logger.error('エラー: CHATWORK_API_TOKEN, CHATWORK_ROOM_ID が設定されていません');
    logger.error('.envファイルを確認してください');
    process.exit(1);
  }

  if (!isReanalyze && !claudeApiKey) {
    logger.error('エラー: CLAUDE_API_KEY が設定されていません');
    logger.error('.envファイルを確認してください');
    process.exit(1);
  }

  // 警告を収集
  const allWarnings: string[] = [];
  const cacheManager = new MessageCacheManager();
  const speakerMapManager = new SpeakerMapManager();
  const teamProfileManager = !isReanalyze ? new TeamProfileManager(teamProfilesPath) : null;

  try {
    let knowledgeItems: AnalyzedMessage[];
    let usedModel = '';

    if (isReanalyze) {
      // === 再出力モード: キャッシュから分析結果を読み込み ===
      logger.info('[1/3] 分析結果キャッシュを読み込み中...\n');
      await cacheManager.showAnalysisStats(roomId);

      const cachedResults = await cacheManager.loadAnalysisResults(roomId);

      if (cachedResults.length === 0) {
        logger.info('分析結果のキャッシュがありません。先に通常モードで実行してください。');
        return;
      }

      logger.info(`キャッシュから${cachedResults.length}件の分析結果を読み込み\n`);

      // 期間フィルタ（キャッシュの分析結果にも適用）
      let filteredResults = cachedResults;
      if (extractFromRaw) {
        const beforeCount = filteredResults.length;
        filteredResults = filterAnalysisResultsByDate(filteredResults, extractFromRaw);
        logger.info(`期間フィルタ適用: ${beforeCount}件 → ${filteredResults.length}件`);
      }

      // 汎用性フィルタ
      logger.info(`汎用性フィルタ: ${outputVersatility.join(', ')} のみ出力`);
      knowledgeItems = filteredResults.filter(
          item => item.versatility !== 'exclude'
              && item.category !== '除外対象'
              && outputVersatility.includes(item.versatility)
      );

      // キャッシュからモデル情報を取得
      const analysisCache = await cacheManager.loadAnalysisCache(roomId);
      usedModel = analysisCache?.model || claudeModel || '(不明)';
      logger.info(`分析モデル: ${usedModel}`);
      logger.info(`フィルタ後: ${knowledgeItems.length}件が形式知化対象\n`);

    } else {
      // === 通常モード: 取得 → 分析 → 出力 ===
      logger.info('[1/5] Chatworkメッセージ取得中...\n');
      const chatworkClient = new ChatworkClient(chatworkToken);

      // ルーム情報を取得
      const roomInfo = await chatworkClient.getRoomInfo(roomId);
      logger.info(`対象ルーム: ${roomInfo.name} (ID: ${roomId})\n`);

      const fetchResult = await chatworkClient.getAllMessages(roomId, maxMessages);
      let messages = fetchResult.messages;

      // 警告を収集
      allWarnings.push(...fetchResult.warnings);

      logger.info(`取得完了: ${messages.length}件\n`);

      // 期間フィルタ
      if (extractFromRaw) {
        const { messages: filtered, description } = chatworkClient.filterByExtractFrom(messages, extractFromRaw);
        messages = filtered;
        logger.info(`期間フィルタ適用（${description}）: ${messages.length}件\n`);
      }

      if (messages.length === 0) {
        logger.info('メッセージがありません。処理を終了します。');
        return;
      }

      // 未分析メッセージを抽出
      const analyzedIds = await cacheManager.getAnalyzedIds(roomId);
      const unanalyzedMessages = cacheManager.getUnanalyzedMessages(messages, analyzedIds);

      logger.info(`未分析メッセージ: ${unanalyzedMessages.length}件\n`);

      if (unanalyzedMessages.length > 0) {
        const roleResolver = teamProfileManager!.hasProfiles()
          ? (accountId: number) => teamProfileManager!.resolveRole(accountId)
          : undefined;

        // メッセージの事前フィルタリング（知見が含まれない可能性が高いものを除外）
        logger.info('事前フィルタリング中...');
        const { filtered: filteredMessages, stats } = filterMessages(unanalyzedMessages, filterConfig);
        logger.info(`  - 対象: ${stats.total}件`);
        logger.info(`  - スキップ: ${stats.skipped}件 (短すぎる/定型文)`);
        logger.info(`  - 切り詰め: ${stats.truncated}件 (${filterConfig.maxLength}文字超)`);
        logger.info(`  - API送信: ${filteredMessages.length}件\n`);

        if (stats.skipped > 0) {
          logger.info('スキップ理由の内訳:');
          for (const [reason, count] of Object.entries(stats.reasons)) {
            logger.info(`  - ${reason}: ${count}件`);
          }
          logger.info('');
        }

        // 発言者マッピングを保存（フィルタリング後のメッセージで保存）
        await speakerMapManager.save(roomId, filteredMessages, roleResolver);

        if (filteredMessages.length > 0) {
          // Step 2: Claude APIで分析（フィルタリング済みメッセージのみ）
          logger.info('[2/5] Claude APIで分析中...\n');

          const analyzer = new ClaudeAnalyzer(claudeApiKey!, {
            promptTemplatePath,
            feedbackPath,
            model: claudeModel,
            apiMode: claudeApiMode
          });
          usedModel = analyzer.getModel();
          logger.info(`使用モデル: ${usedModel}`);

          if (claudeApiMode === 'batch') {
            logger.info('※ Batch API: 50%割引、処理時間は数分〜24時間\n');
          } else {
            logger.info('※ Realtime API: 通常価格、処理時間は数秒〜数分\n');
          }

          const roleResolver = teamProfileManager!.hasProfiles()
              ? (accountId: number) => teamProfileManager!.resolveRole(accountId)
              : undefined;
          const analyzed = await analyzer.analyze(filteredMessages, roleResolver);

          // 分析したメッセージIDを記録（フィルタリング済みメッセージのみ）
          const newlyAnalyzedIds = filteredMessages.map(m => m.message_id);
          await cacheManager.markAsAnalyzed(roomId, newlyAnalyzedIds);

          // 分析結果をキャッシュに保存（モデル情報付き）
          logger.info('\n[3/5] 分析結果をキャッシュに保存中...\n');
          await cacheManager.saveAnalysisResults(roomId, analyzed, usedModel);
        } else {
          logger.info('フィルタリング後、新規の分析対象メッセージはありません。キャッシュがあれば出力します。\n');
        }
      } else {
        logger.info('新しく分析するメッセージはありません。キャッシュがあれば出力します。\n');
      }

      // 既存キャッシュから分析結果を読み込み
      let allResults = await cacheManager.loadAnalysisResults(roomId);

      // 期間フィルタ（出力対象にも適用）
      if (extractFromRaw) {
        const beforeCount = allResults.length;
        allResults = filterAnalysisResultsByDate(allResults, extractFromRaw);
        logger.info(`期間フィルタ適用（出力対象）: ${beforeCount}件 → ${allResults.length}件`);
      }

      logger.info(`汎用性フィルタ: ${outputVersatility.join(', ')} のみ出力`);
      logger.debug(`フィルタリング前: ${allResults.length}件`);

      // デバッグ: versatility分布を表示
      const versatilityDist = allResults.reduce((acc, item) => {
        acc[item.versatility] = (acc[item.versatility] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      logger.debug(`versatility分布:`, versatilityDist);

      knowledgeItems = allResults.filter(
          item => item.versatility !== 'exclude'
              && item.category !== '除外対象'
              && outputVersatility.includes(item.versatility)
      );

      logger.debug(`フィルタリング後: ${knowledgeItems.length}件`);

      // usedModelがまだ設定されていない場合（新規分析なし）、キャッシュから取得
      if (!usedModel) {
        const analysisCache = await cacheManager.loadAnalysisCache(roomId);
        usedModel = analysisCache?.model || claudeModel || '(不明)';
      }

      logger.info(`全体で ${knowledgeItems.length}件が形式知化対象\n`);
    }

    if (knowledgeItems.length === 0) {
      logger.info('出力対象の知見がありません。');
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
    logger.info(`${stepPrefix} 内部用Markdown出力中（発言者あり）...\n`);
    const internalDir = join(outputDir, 'internal');
    const internalMdPath = join(internalDir, `${baseFilename}.md`);
    const markdownFormatter = new MarkdownFormatter();
    await markdownFormatter.format(knowledgeItems, internalMdPath, {
      ...formatOptions,
      anonymize: false
    }, speakerMapManager, roomId, cacheManager);

    // === 外部用Markdown出力（匿名化） ===
    logger.info(`\n${stepPrefix2} 外部用出力中（匿名化）...\n`);
    const externalDir = join(outputDir, 'external');
    const externalMdPath = join(externalDir, `${baseFilename}.md`);
    await markdownFormatter.format(knowledgeItems, externalMdPath, {
      ...formatOptions,
      anonymize: true
    }, speakerMapManager, roomId);

    // === 外部用JSON出力（匿名化） ===
    const externalJsonPath = join(externalDir, `${baseFilename}.json`);
    const jsonFormatter = new JSONFormatter();
    await jsonFormatter.format(knowledgeItems, externalJsonPath, {
      ...formatOptions,
      anonymize: true
    }, speakerMapManager, roomId);

    // 完了
    logger.info('\n=== 完了 ===');
    logger.info(`\n出力ファイル:`);
    logger.info(`  [内部用・発言者あり]`);
    logger.info(`  - ${internalMdPath}`);
    logger.info(`  [外部用・匿名化済み]`);
    logger.info(`  - ${externalMdPath}`);
    logger.info(`  - ${externalJsonPath}`);
    logger.info(`\n形式知化された知見: ${knowledgeItems.length}件`);

    // カテゴリ別集計
    const categoryCount: Record<string, number> = {};
    for (const item of knowledgeItems) {
      categoryCount[item.category] = (categoryCount[item.category] || 0) + 1;
    }

    logger.info('\nカテゴリ別内訳:');
    for (const [category, count] of Object.entries(categoryCount)) {
      logger.info(`  ${category}: ${count}件`);
    }

    // 汎用性レベル別集計
    const versatilityCount: Record<string, number> = {};
    for (const item of knowledgeItems) {
      versatilityCount[item.versatility] = (versatilityCount[item.versatility] || 0) + 1;
    }

    logger.info('\n汎用性レベル別内訳:');
    for (const [level, count] of Object.entries(versatilityCount)) {
      logger.info(`  ${level}: ${count}件`);
    }

    // 警告があれば表示
    if (allWarnings.length > 0) {
      logger.info('\n=== 警告 ===\n');
      for (const warning of allWarnings) {
        logger.info(warning);
        logger.info('');
      }
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`\nエラーが発生しました: ${errorMsg}`, error);
    process.exit(1);
  }
}

/**
 * 分析結果をEXTRACT_FROM形式で期間フィルタ
 * item.date（ISO文字列）を使って判定
 */
function filterAnalysisResultsByDate(results: AnalyzedMessage[], extractFrom: string): AnalyzedMessage[] {
  const logger = new Logger('Filter');
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
      logger.warn(`EXTRACT_FROM の形式が不正です: ${extractFrom}`);
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
