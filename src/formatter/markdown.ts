import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

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
  async format(messages: AnalyzedMessage[], outputPath: string, options: FormatOptions = {}): Promise<void> {
    // 匿名化が必要な場合、コピーして発言者を置換
    let items = messages;
    if (options.anonymize) {
      items = this.anonymizeItems(messages);
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
   * 発言者名を匿名化したコピーを返す（元データは変更しない）
   */
  private anonymizeItems(messages: AnalyzedMessage[]): AnalyzedMessage[] {
    const speakerMap = new Map<string, string>();
    let count = 0;

    return messages.map(item => {
      if (!speakerMap.has(item.speaker)) {
        count++;
        speakerMap.set(item.speaker, `発言者${count}`);
      }
      return { ...item, speaker: speakerMap.get(item.speaker)! };
    });
  }

  /**
   * カテゴリ別にグループ化
   */
  private groupByCategory(messages: AnalyzedMessage[]): Record<string, AnalyzedMessage[]> {
    const grouped: Record<string, AnalyzedMessage[]> = {};
    
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
    const roomInfo = options.roomName
      ? `対象ルーム: ${options.roomName}${options.roomId ? ` (ID: ${options.roomId})` : ''}\n`
      : '';
    const modelInfo = options.model ? `分析モデル: ${options.model}\n` : '';

    return `# Chatwork知見まとめ

${roomInfo}${modelInfo}生成日時: ${now.toLocaleString('ja-JP')}

---

`;
  }

  /**
   * カテゴリセクション生成
   */
  private generateCategorySection(category: string, items: AnalyzedMessage[]): string {
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
  private generateMessageBlock(item: AnalyzedMessage): string {
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
