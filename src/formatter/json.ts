import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export interface FormatOptions {
  roomName?: string;
  roomId?: string;
  model?: string;
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
    const exportData: KnowledgeExport = {
      export_date: new Date().toISOString(),
      total_items: messages.length,
      items: messages
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
}
