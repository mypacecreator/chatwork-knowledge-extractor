import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { anonymizeSpeakers } from './anonymize.js';
import { SpeakerMapManager } from '../cache/speakerMap.js';

export interface FormatOptions {
  roomName?: string;
  roomId?: string;
  model?: string;
  anonymize?: boolean;
}

export class MarkdownFormatter {
  /**
   * 分析結果をMarkdown形式で出力
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

    // カテゴリ別にグループ化
    const grouped = this.groupByCategory(items);

    // Markdownを生成
    let markdown = this.generateHeader(options);

    for (const [category, categoryItems] of Object.entries(grouped)) {
      markdown += this.generateCategorySection(category, categoryItems);
    }

    // ファイル出力
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, 'utf-8');
    console.log(`[Markdown] 出力完了: ${outputPath}`);
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
        console.warn(`[Formatter] message_id ${item.message_id} のSpeaker情報が見つかりません。デフォルト値を使用します。`);
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
        console.warn(`[Formatter] message_id ${item.message_id} のSpeaker情報が見つかりません。デフォルト値を使用します。`);
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
  private generateCategorySection(category: string, items: (AnalyzedMessage & { speaker: string })[]): string {
    const emoji = this.getCategoryEmoji(category);
    let section = `## ${emoji} ${category}\n\n`;

    for (const item of items) {
      section += this.generateMessageBlock(item);
      section += '\n---\n\n';
    }

    return section;
  }

  /**
   * 個別メッセージブロック生成
   */
  private generateMessageBlock(item: AnalyzedMessage & { speaker: string }): string {
    return `### [汎用性: ${item.versatility}] ${item.title}

- **発言者**: ${item.speaker}
- **日時**: ${new Date(item.date).toLocaleString('ja-JP')}
- **タグ**: ${item.tags.map(tag => `\`${tag}\``).join(', ')}

${item.formatted_content}

`;
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
}
