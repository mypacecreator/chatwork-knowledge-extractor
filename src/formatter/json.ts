import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

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
    name: string;
    id: string;
  };
  total_items: number;
  items: AnalyzedMessage[];
}

export class JSONFormatter {
  /**
   * 分析結果をJSON形式で出力
   */
  async format(messages: AnalyzedMessage[], outputPath: string, options: FormatOptions = {}): Promise<void> {
    // 匿名化が必要な場合、コピーして発言者を置換
    let items = messages;
    if (options.anonymize) {
      items = this.anonymizeItems(messages);
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

    // ルーム情報を追加
    if (options.roomName) {
      exportData.room = {
        name: options.roomName,
        id: options.roomId || ''
      };
    }

    // ファイル出力
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    console.log(`[JSON] 出力完了: ${outputPath}`);
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
}
