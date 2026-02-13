import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { SpeakerMapManager } from '../cache/speakerMap.js';
import { Logger } from '../utils/logger.js';

export interface FormatOptions {
  roomName?: string;
  roomId?: string;
  model?: string;
  anonymize?: boolean;
}

interface KnowledgeExport {
  export_date: string;
  model?: string;
  room?: {
    name?: string;  // 匿名化時は省略される可能性があるためoptional
    id: string;
  };
  total_items: number;
  items: AnalyzedMessage[];
}

export class JSONFormatter {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('JSON');
  }

  /**
   * 分析結果をJSON形式で出力
   */
  async format(
    messages: AnalyzedMessage[],
    outputPath: string,
    options: FormatOptions = {},
    speakerMapManager: SpeakerMapManager,
    roomId: string
  ): Promise<void> {
    let items: (AnalyzedMessage & { speaker: string })[];

    // SpeakerMapから発言者情報を取得（必須）
    if (options.anonymize) {
      // External用: message_idベースで機械的に匿名化
      items = await this.anonymizeWithMessageId(messages, speakerMapManager, roomId);
    } else {
      // Internal用: SpeakerMapから実名を取得
      items = await this.applySpeakerNames(messages, speakerMapManager, roomId);
    }

    const exportData: KnowledgeExport = {
      export_date: new Date().toISOString(),
      total_items: items.length,
      items
    };

    // モデル情報を追加
    if (options.model) {
      exportData.model = options.model;
    }

    // ルーム情報を追加（anonymize フラグで制御）
    if (options.roomName || options.roomId) {
      if (options.anonymize) {
        // 匿名化時はIDのみ
        exportData.room = {
          id: options.roomId || ''
        };
      } else {
        // 内部用は実名表示
        exportData.room = {
          name: options.roomName,
          id: options.roomId || ''
        };
      }
    }

    // ファイル出力
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    this.logger.info(`出力完了: ${outputPath}`);
  }

  /**
   * message_idベースでSpeakerMapから実名を取得
   */
  private async applySpeakerNames(
    messages: AnalyzedMessage[],
    speakerMapManager: SpeakerMapManager,
    roomId: string
  ): Promise<(AnalyzedMessage & { speaker: string })[]> {
    const speakerMap = await speakerMapManager.load(roomId);
    if (!speakerMap) {
      throw new Error(`[Formatter] SpeakerMapが見つかりません: speakers_${roomId}.json`);
    }

    return messages.map(item => {
      const speakerInfo = speakerMap.speakers[item.message_id];
      if (!speakerInfo) {
        this.logger.warn(`message_id ${item.message_id} のSpeaker情報が見つかりません。デフォルト値を使用します。`);
        return { ...item, speaker: '不明' };
      }
      return { ...item, speaker: speakerInfo.speaker_name };
    });
  }

  /**
   * message_idベースで機械的に匿名化
   * account_idごとに一意な匿名ID（発言者1, 発言者2...）を割り当て
   */
  private async anonymizeWithMessageId(
    messages: AnalyzedMessage[],
    speakerMapManager: SpeakerMapManager,
    roomId: string
  ): Promise<(AnalyzedMessage & { speaker: string })[]> {
    const speakerMap = await speakerMapManager.load(roomId);
    if (!speakerMap) {
      throw new Error(`[Formatter] SpeakerMapが見つかりません: speakers_${roomId}.json`);
    }

    // account_id → 匿名IDのマッピングを作成
    const accountIdToAnonymousId = new Map<number, string>();
    let counter = 1;

    // 一貫性のため、account_idでソート
    const allAccountIds = new Set<number>();
    for (const msg of messages) {
      const speakerInfo = speakerMap.speakers[msg.message_id];
      if (speakerInfo) {
        allAccountIds.add(speakerInfo.account_id);
      }
    }

    const sortedAccountIds = Array.from(allAccountIds).sort((a, b) => a - b);
    for (const accountId of sortedAccountIds) {
      accountIdToAnonymousId.set(accountId, `発言者${counter}`);
      counter++;
    }

    return messages.map(item => {
      const speakerInfo = speakerMap.speakers[item.message_id];
      if (!speakerInfo) {
        this.logger.warn(`message_id ${item.message_id} のSpeaker情報が見つかりません。デフォルト値を使用します。`);
        return { ...item, speaker: '不明' };
      }

      return {
        ...item,
        speaker: accountIdToAnonymousId.get(speakerInfo.account_id)!
      };
    });
  }

}
