import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type { ChatworkMessage } from '../chatwork/client.js';

export interface MessageCache {
  roomId: string;
  lastUpdated: string;
  lastMessageId: string | null;
  messages: ChatworkMessage[];
}

export class MessageCacheManager {
  private cacheDir: string;

  constructor(cacheDir: string = './cache') {
    this.cacheDir = cacheDir;
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
      console.error(`[Cache] 読み込みエラー: ${e}`);
      return null;
    }
  }

  /**
   * キャッシュを保存
   */
  async save(roomId: string, messages: ChatworkMessage[]): Promise<void> {
    const cachePath = this.getCachePath(roomId);

    // ディレクトリがなければ作成
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // message_idでソート（新しい順）
    const sortedMessages = [...messages].sort(
      (a, b) => parseInt(b.message_id) - parseInt(a.message_id)
    );

    const cache: MessageCache = {
      roomId,
      lastUpdated: new Date().toISOString(),
      lastMessageId: sortedMessages.length > 0 ? sortedMessages[0].message_id : null,
      messages: sortedMessages
    };

    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    console.log(`[Cache] 保存完了: ${messages.length}件 (${cachePath})`);
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
      console.log(`[Cache] ${addedCount}件の新規メッセージを追加`);
    }

    return merged;
  }

  /**
   * キャッシュの統計情報を表示
   */
  async showStats(roomId: string): Promise<void> {
    const cache = await this.load(roomId);

    if (!cache) {
      console.log('[Cache] キャッシュなし（初回実行）');
      return;
    }

    const oldestMsg = cache.messages[cache.messages.length - 1];
    const newestMsg = cache.messages[0];

    console.log(`[Cache] 統計情報:`);
    console.log(`  - 保存件数: ${cache.messages.length}件`);
    console.log(`  - 最終更新: ${cache.lastUpdated}`);
    if (oldestMsg) {
      console.log(`  - 最古: ${new Date(oldestMsg.send_time * 1000).toLocaleString('ja-JP')}`);
    }
    if (newestMsg) {
      console.log(`  - 最新: ${new Date(newestMsg.send_time * 1000).toLocaleString('ja-JP')}`);
    }
  }
}
