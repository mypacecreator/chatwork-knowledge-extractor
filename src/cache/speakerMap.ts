import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { ChatworkMessage } from '../chatwork/client.js';
import { ResolvedRole } from '../team/profiles.js';
import { Logger } from '../utils/logger.js';

/**
 * 発言者情報
 */
export interface SpeakerInfo {
  account_id: number;
  speaker_name: string;
  speaker_role?: string;
}

/**
 * SpeakerMapキャッシュ
 */
export interface SpeakerMapCache {
  roomId: string;
  lastUpdated: string;
  speakers: Record<string, SpeakerInfo>;  // message_id → SpeakerInfo
}

/**
 * 発言者マッピングを管理するクラス
 * message_id → 発言者情報のマッピングをキャッシュファイルで管理
 */
export class SpeakerMapManager {
  private cacheDir: string;
  private logger: Logger;

  constructor(cacheDir: string = './cache') {
    this.cacheDir = cacheDir;
    this.logger = new Logger('SpeakerMap');
  }

  private getCachePath(roomId: string): string {
    return join(this.cacheDir, `speakers_${roomId}.json`);
  }

  /**
   * キャッシュを読み込む
   */
  async load(roomId: string): Promise<SpeakerMapCache | null> {
    const cachePath = this.getCachePath(roomId);
    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const content = await readFile(cachePath, 'utf-8');
      return JSON.parse(content) as SpeakerMapCache;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.logger.error(`読み込みエラー: ${errorMsg}`, e);
      return null;
    }
  }

  /**
   * 発言者マッピングを保存（既存とマージ）
   */
  async save(roomId: string, messages: ChatworkMessage[], roleResolver?: (accountId: number) => ResolvedRole): Promise<void> {
    const cachePath = this.getCachePath(roomId);
    const existing = await this.load(roomId);

    // 新しいマッピングを作成
    const newSpeakers: Record<string, SpeakerInfo> = {};
    for (const msg of messages) {
      const resolved = roleResolver?.(msg.account.account_id);
      newSpeakers[msg.message_id] = {
        account_id: msg.account.account_id,
        speaker_name: msg.account.name,
        speaker_role: resolved?.role
      };
    }

    // 既存とマージ
    const merged = {
      ...existing?.speakers,
      ...newSpeakers
    };

    const cacheData: SpeakerMapCache = {
      roomId,
      lastUpdated: new Date().toISOString(),
      speakers: merged
    };

    // ディレクトリがなければ作成
    const dir = dirname(cachePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
    this.logger.info(`保存完了: ${Object.keys(newSpeakers).length}件 (合計: ${Object.keys(merged).length}件)`);
  }

  /**
   * message_idから発言者情報を取得
   */
  async getSpeakerInfo(roomId: string, messageId: string): Promise<SpeakerInfo | null> {
    const cache = await this.load(roomId);
    return cache?.speakers[messageId] || null;
  }
}
