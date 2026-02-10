import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

export interface FormatOptions {
  roomName?: string;
  roomId?: string;
}

export class MarkdownFormatter {
  /**
   * 分析結果をMarkdown形式で出力
   */
  async format(messages: AnalyzedMessage[], outputPath: string, options: FormatOptions = {}): Promise<void> {
    // カテゴリ別にグループ化
    const grouped = this.groupByCategory(messages);

    // Markdownを生成
    let markdown = this.generateHeader(options);

    for (const [category, items] of Object.entries(grouped)) {
      markdown += this.generateCategorySection(category, items);
    }

    // ファイル出力
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, 'utf-8');
    console.log(`[Markdown] 出力完了: ${outputPath}`);
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

    return `# Chatwork知見まとめ

${roomInfo}生成日時: ${now.toLocaleString('ja-JP')}

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
