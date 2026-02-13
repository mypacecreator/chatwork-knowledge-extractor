import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type { ChatworkMessage } from '../chatwork/client.js';
import type { AnalyzedMessage } from '../claude/analyzer.js';
import { Logger } from '../utils/logger.js';

export interface MessageCache {
  roomId: string;
  lastUpdated: string;
  lastMessageId: string | null;
  messages: ChatworkMessage[];
  analyzedMessageIds: string[]; // 分析済みのmessage_id一覧
}

export class MessageCacheManager {
  private cacheDir: string;
  private logger: Logger;

  constructor(cacheDir: string = './cache') {
    this.cacheDir = cacheDir;
    this.logger = new Logger('Cache');
  }

  private getCachePath(roomId: string): string {
    return join(this.cacheDir, `room_${roomId}.json`);
  }

  /**
   * キャッシュを読み込む
   */
  async load(roomId: string): Promise<MessageCache | null> {
    const cachePath = this.getCachePath(roomId);

    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const content = await readFile(cachePath, 'utf-8');
      return JSON.parse(content) as MessageCache;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.logger.error(`読み込みエラー: ${errorMsg}`, e);
      return null;
    }
  }

  /**
   * キャッシュを保存
   */
  async save(roomId: string, messages: ChatworkMessage[], analyzedMessageIds?: string[]): Promise<void> {
    const cachePath = this.getCachePath(roomId);

    // ディレクトリがなければ作成
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // 既存キャッシュから分析済みIDを取得
    const existingCache = await this.load(roomId);
    const existingAnalyzedIds = existingCache?.analyzedMessageIds || [];

    // 新しい分析済みIDをマージ
    const allAnalyzedIds = [...new Set([...existingAnalyzedIds, ...(analyzedMessageIds || [])])];

    // message_idでソート（新しい順）
    const sortedMessages = [...messages].sort(
      (a, b) => parseInt(b.message_id) - parseInt(a.message_id)
    );

    const cache: MessageCache = {
      roomId,
      lastUpdated: new Date().toISOString(),
      lastMessageId: sortedMessages.length > 0 ? sortedMessages[0].message_id : null,
      messages: sortedMessages,
      analyzedMessageIds: allAnalyzedIds
    };

    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    this.logger.info(`保存完了: ${messages.length}件 (${cachePath})`);
  }

  /**
   * 未分析のメッセージのみを取得
   */
  getUnanalyzedMessages(messages: ChatworkMessage[], analyzedIds: string[]): ChatworkMessage[] {
    const analyzedSet = new Set(analyzedIds);
    return messages.filter(msg => !analyzedSet.has(msg.message_id));
  }

  /**
   * 分析済みIDを追加保存
   */
  async markAsAnalyzed(roomId: string, messageIds: string[]): Promise<void> {
    const cache = await this.load(roomId);
    if (!cache) return;

    const allAnalyzedIds = [...new Set([...cache.analyzedMessageIds, ...messageIds])];
    cache.analyzedMessageIds = allAnalyzedIds;
    cache.lastUpdated = new Date().toISOString();

    const cachePath = this.getCachePath(roomId);
    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    this.logger.info(`分析済みとしてマーク: ${messageIds.length}件`);
  }

  /**
   * 新しいメッセージを既存キャッシュにマージ
   */
  mergeMessages(
    existing: ChatworkMessage[],
    newMessages: ChatworkMessage[]
  ): ChatworkMessage[] {
    // 既存のmessage_idセット
    const existingIds = new Set(existing.map(m => m.message_id));

    // 重複を除いて追加
    const merged = [...existing];
    let addedCount = 0;

    for (const msg of newMessages) {
      if (!existingIds.has(msg.message_id)) {
        merged.push(msg);
        addedCount++;
      }
    }

    // 時系列でソート（新しい順）
    merged.sort((a, b) => b.send_time - a.send_time);

    if (addedCount > 0) {
      this.logger.info(`${addedCount}件の新規メッセージを追加`);
    }

    return merged;
  }

  /**
   * キャッシュの統計情報を表示
   */
  async showStats(roomId: string): Promise<void> {
    const cache = await this.load(roomId);

    if (!cache) {
      this.logger.info('キャッシュなし（初回実行）');
      return;
    }

    const oldestMsg = cache.messages[cache.messages.length - 1];
    const newestMsg = cache.messages[0];
    const analyzedCount = cache.analyzedMessageIds?.length || 0;
    const unanalyzedCount = cache.messages.length - analyzedCount;

    this.logger.info(`統計情報:`);
    this.logger.info(`  - 保存件数: ${cache.messages.length}件`);
    this.logger.info(`  - 分析済み: ${analyzedCount}件 / 未分析: ${unanalyzedCount}件`);
    this.logger.info(`  - 最終更新: ${cache.lastUpdated}`);
    if (oldestMsg) {
      this.logger.info(`  - 最古: ${new Date(oldestMsg.send_time * 1000).toLocaleString('ja-JP')}`);
    }
    if (newestMsg) {
      this.logger.info(`  - 最新: ${new Date(newestMsg.send_time * 1000).toLocaleString('ja-JP')}`);
    }
  }

  /**
   * 分析済みIDリストを取得
   */
  async getAnalyzedIds(roomId: string): Promise<string[]> {
    const cache = await this.load(roomId);
    return cache?.analyzedMessageIds || [];
  }

  // === 分析結果キャッシュ ===

  private getAnalysisCachePath(roomId: string): string {
    return join(this.cacheDir, `analysis_${roomId}.json`);
  }

  /**
   * 分析結果をキャッシュに保存（既存結果とマージ）
   */
  async saveAnalysisResults(roomId: string, results: AnalyzedMessage[], model?: string): Promise<void> {
    const cachePath = this.getAnalysisCachePath(roomId);

    // ディレクトリがなければ作成
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // 既存結果を読み込んでマージ
    const existing = await this.loadAnalysisResults(roomId);
    const merged = this.mergeAnalysisResults(existing, results);

    const cacheData: AnalysisCache = {
      roomId,
      lastUpdated: new Date().toISOString(),
      model,
      results: merged
    };

    await writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
    this.logger.info(`分析結果を保存: ${merged.length}件 (新規${results.length}件)`);
  }

  /**
   * キャッシュから分析結果を読み込む
   */
  async loadAnalysisResults(roomId: string): Promise<AnalyzedMessage[]> {
    const cache = await this.loadAnalysisCache(roomId);
    return cache?.results || [];
  }

  /**
   * キャッシュ全体（model情報含む）を読み込む
   */
  async loadAnalysisCache(roomId: string): Promise<AnalysisCache | null> {
    const cachePath = this.getAnalysisCachePath(roomId);

    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const content = await readFile(cachePath, 'utf-8');
      return JSON.parse(content) as AnalysisCache;
    } catch (e) {
      this.logger.error(`分析結果読み込みエラー: ${e}`);
      return null;
    }
  }

  /**
   * 分析結果をマージ（message_idで重複排除、新しい結果を優先）
   */
  private mergeAnalysisResults(
    existing: AnalyzedMessage[],
    newResults: AnalyzedMessage[]
  ): AnalyzedMessage[] {
    const resultMap = new Map<string, AnalyzedMessage>();

    // 既存結果をセット
    for (const item of existing) {
      resultMap.set(item.message_id, item);
    }

    // 新しい結果で上書き
    for (const item of newResults) {
      resultMap.set(item.message_id, item);
    }

    return Array.from(resultMap.values());
  }

  /**
   * 分析結果キャッシュの統計を表示
   */
  async showAnalysisStats(roomId: string): Promise<void> {
    const results = await this.loadAnalysisResults(roomId);

    if (results.length === 0) {
      this.logger.info('分析結果キャッシュなし');
      return;
    }

    this.logger.info(`分析結果キャッシュ: ${results.length}件`);
  }
}

export interface AnalysisCache {
  roomId: string;
  lastUpdated: string;
  model?: string;
  results: AnalyzedMessage[];
}
