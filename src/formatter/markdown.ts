import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { SpeakerMapManager } from '../cache/speakerMap.js';
import { MessageCacheManager } from '../cache/messages.js';
import { Logger } from '../utils/logger.js';

export interface FormatOptions {
  roomName?: string;
  roomId?: string;
  model?: string;
  anonymize?: boolean;
}

export class MarkdownFormatter {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('Markdown');
  }

  /**
   * 分析結果をMarkdown形式で出力
   */
  async format(
    messages: AnalyzedMessage[],
    outputPath: string,
    options: FormatOptions = {},
    speakerMapManager: SpeakerMapManager,
    roomId: string,
    messageCacheManager?: MessageCacheManager
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

    // カテゴリ別にグループ化
    const grouped = this.groupByCategory(items);

    // Markdownを生成
    let markdown = this.generateHeader(options);

    for (const [category, categoryItems] of Object.entries(grouped)) {
      markdown += await this.generateCategorySection(category, categoryItems, options.anonymize || false, messageCacheManager, roomId);
    }

    // ファイル出力
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, 'utf-8');
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
      // ロール情報があれば表示
      const roleLabel = this.getRoleLabel(speakerInfo.speaker_role);
      const speaker = roleLabel ? `${speakerInfo.speaker_name} (${roleLabel})` : speakerInfo.speaker_name;
      return { ...item, speaker };
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

  /**
   * カテゴリ別にグループ化
   */
  private groupByCategory(messages: (AnalyzedMessage & { speaker: string })[]): Record<string, (AnalyzedMessage & { speaker: string })[]> {
    const grouped: Record<string, (AnalyzedMessage & { speaker: string })[]> = {};
    
    for (const msg of messages) {
      if (!grouped[msg.category]) {
        grouped[msg.category] = [];
      }
      grouped[msg.category].push(msg);
    }

    // 各カテゴリ内で汎用性の高い順にソート
    for (const category in grouped) {
      grouped[category].sort((a, b) => {
        const order: Record<string, number> = { high: 0, medium: 1, low: 2, exclude: 3 };
        return order[a.versatility] - order[b.versatility];
      });
    }

    return grouped;
  }

  /**
   * ヘッダー生成
   */
  private generateHeader(options: FormatOptions): string {
    const now = new Date();

    // ルーム名の表示を anonymize フラグで制御
    let roomInfo = '';
    if (options.roomName || options.roomId) {
      if (options.anonymize) {
        // 匿名化時はIDのみ表示
        roomInfo = options.roomId ? `対象ルーム: ID ${options.roomId}\n` : '';
      } else {
        // 内部用は実名表示
        roomInfo = `対象ルーム: ${options.roomName}${options.roomId ? ` (ID: ${options.roomId})` : ''}\n`;
      }
    }

    const modelInfo = options.model ? `分析モデル: ${options.model}\n` : '';

    return `# Chatwork知見まとめ

${roomInfo}${modelInfo}生成日時: ${now.toLocaleString('ja-JP')}

---

`;
  }

  /**
   * カテゴリセクション生成
   */
  private async generateCategorySection(
    category: string, 
    items: (AnalyzedMessage & { speaker: string })[], 
    isAnonymized: boolean,
    messageCacheManager: MessageCacheManager | undefined,
    roomId: string
  ): Promise<string> {
    const emoji = this.getCategoryEmoji(category);
    let section = `## ${emoji} ${category}\n\n`;

    // パフォーマンス最適化: message_id → 元発言のマップを事前作成
    let messageMap: Map<string, string> | null = null;
    if (!isAnonymized && messageCacheManager) {
      messageMap = await this.createMessageMap(messageCacheManager, roomId);
    }

    for (const item of items) {
      section += await this.generateMessageBlock(item, isAnonymized, messageMap);
      section += '\n---\n\n';
    }

    return section;
  }

  /**
   * メッセージIDからメッセージ本文へのマップを作成（O(1)ルックアップ用）
   */
  private async createMessageMap(
    messageCacheManager: MessageCacheManager,
    roomId: string
  ): Promise<Map<string, string>> {
    const messageMap = new Map<string, string>();
    try {
      const cache = await messageCacheManager.load(roomId);
      if (cache) {
        for (const msg of cache.messages) {
          messageMap.set(msg.message_id, msg.body);
        }
      }
    } catch (e) {
      this.logger.warn(`メッセージキャッシュの読み込みに失敗 (roomId: ${roomId})`, e);
    }
    return messageMap;
  }

  /**
   * 個別メッセージブロック生成
   */
  private async generateMessageBlock(
    item: AnalyzedMessage & { speaker: string },
    isAnonymized: boolean,
    messageMap: Map<string, string> | null
  ): Promise<string> {
    let block = `### [汎用性: ${item.versatility}] ${item.title}

- 発言者: ${item.speaker}
- 日時: ${new Date(item.date).toLocaleString('ja-JP')}
- タグ: ${item.tags.map(tag => `\`${tag}\``).join(', ')}

${item.formatted_content}

`;

    // 内部用の場合のみ、元発言を追加
    if (!isAnonymized && messageMap) {
      const originalMessage = messageMap.get(item.message_id);
      if (originalMessage) {
        block += `元発言 (メッセージID: ${item.message_id}):\n\n${this.formatAsQuotedBlock(originalMessage)}\n\n`;
      }
    }

    return block;
  }

  /**
   * テキストをMarkdownの引用ブロック形式に変換
   */
  private formatAsQuotedBlock(text: string): string {
    // 末尾の改行を除去してから引用符を付ける
    const trimmed = text.replace(/\n+$/, '');
    return `> ${trimmed.replace(/\n/g, '\n> ')}`;
  }

  /**
   * カテゴリに対応する絵文字を返す
   */
  private getCategoryEmoji(category: string): string {
    const emojiMap: Record<string, string> = {
      '実装ノウハウ': '🔧',
      '制作方針・指示出し': '📋',
      'トラブル対応': '🚨',
      '質疑応答・相談': '💬',
      '定型的なやりとり': '📌'
    };
    return emojiMap[category] || '📄';
  }

  /**
   * ロールをラベル表示に変換
   */
  private getRoleLabel(role: string | undefined): string {
    if (!role) return '';
    const labelMap: Record<string, string> = {
      'senior': 'Senior',
      'member': 'Member',
      'junior': 'Junior'
    };
    // 未知のロールは空文字を返す（一貫性を保つため）
    return labelMap[role] || '';
  }
}
