import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { anonymizeSpeakers } from './anonymize.js';

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
  /**
   * 分析結果をJSON形式で出力
   */
  async format(messages: AnalyzedMessage[], outputPath: string, options: FormatOptions = {}): Promise<void> {
    // 匿名化が必要な場合、コピーして発言者を置換
    let items = messages;
    if (options.anonymize) {
      items = anonymizeSpeakers(messages);
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
    console.log(`[JSON] 出力完了: ${outputPath}`);
  }

}
