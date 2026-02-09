import type { AnalyzedMessage } from '../claude/analyzer.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

interface KnowledgeExport {
  export_date: string;
  period?: {
    from?: string;
    to?: string;
  };
  total_items: number;
  items: AnalyzedMessage[];
}

export class JSONFormatter {
  /**
   * 分析結果をJSON形式で出力
   */
  async format(messages: AnalyzedMessage[], outputPath: string): Promise<void> {
    const exportData: KnowledgeExport = {
      export_date: new Date().toISOString(),
      total_items: messages.length,
      items: messages
    };

    // ファイル出力
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    console.log(`[JSON] 出力完了: ${outputPath}`);
  }
}
