import Anthropic from '@anthropic-ai/sdk';
import type { ChatworkMessage } from '../chatwork/client.js';

export interface AnalyzedMessage {
  message_id: string;
  category: string;
  versatility: 'high' | 'medium' | 'low';
  title: string;
  tags: string[];
  speaker: string;
  date: string;
  formatted_content: string;
  original_body: string;
}

export class ClaudeAnalyzer {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Batch APIでメッセージを分析
   * 50%割引が適用される
   */
  async analyzeBatch(messages: ChatworkMessage[]): Promise<AnalyzedMessage[]> {
    console.log(`[Claude] Batch API処理開始: ${messages.length}件のメッセージ`);

    // Batch API用のリクエストを作成
    const requests = messages.map((msg, index) => ({
      custom_id: `msg_${msg.message_id}`,
      params: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1000,
        messages: [{
          role: 'user' as const,
          content: this.createAnalysisPrompt(msg)
        }]
      }
    }));

    // Batch作成
    const batch = await this.client.beta.messages.batches.create({
      requests
    });

    console.log(`[Claude] Batch作成完了: ${batch.id}`);
    console.log(`[Claude] ステータス: ${batch.processing_status}`);

    // Batch完了を待機
    const completedBatch = await this.waitForBatchCompletion(batch.id);
    
    // 結果を取得
    const results = await this.client.beta.messages.batches.results(completedBatch.id);
    
    // 結果をパース
    const analyzed: AnalyzedMessage[] = [];
    for await (const result of results) {
      if (result.result.type === 'succeeded') {
        const content = result.result.message.content[0];
        if (content.type === 'text') {
          try {
            // マークダウンのコードブロックからJSONを抽出
            let jsonText = content.text.trim();
            const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1].trim();
            }

            const parsed = JSON.parse(jsonText);
            analyzed.push(parsed);
          } catch (e) {
            console.error(`[Claude] JSON parse error for ${result.custom_id}`);
            console.error(`[Claude] Raw response: ${content.text.substring(0, 500)}`);
          }
        }
      } else {
        console.error(`[Claude] Failed: ${result.custom_id}`);
      }
    }

    console.log(`[Claude] 分析完了: ${analyzed.length}件`);
    return analyzed;
  }

  /**
   * Batch完了を待機
   */
  private async waitForBatchCompletion(batchId: string): Promise<Anthropic.Beta.Messages.BetaMessageBatch> {
    let batch = await this.client.beta.messages.batches.retrieve(batchId);
    const totalRequests = batch.request_counts.processing + batch.request_counts.succeeded + batch.request_counts.errored + batch.request_counts.canceled + batch.request_counts.expired;

    while (batch.processing_status === 'in_progress') {
      console.log(`[Claude] 処理中... (${batch.request_counts.processing}/${totalRequests})`);
      await this.sleep(10000); // 10秒ごとにチェック
      batch = await this.client.beta.messages.batches.retrieve(batchId);
    }

    console.log(`[Claude] Batch完了: ${batch.processing_status}`);
    console.log(`[Claude] 成功: ${batch.request_counts.succeeded}, 失敗: ${batch.request_counts.errored}`);
    
    return batch;
  }

  /**
   * メッセージ分析用のプロンプト作成
   */
  private createAnalysisPrompt(message: ChatworkMessage): string {
    return `あなたはWeb制作チームのチャット履歴から形式知化できる知見を抽出するアシスタントです。

以下のメッセージを分析し、JSON形式で結果を返してください。

【メッセージ】
発言者: ${message.account.name}
日時: ${new Date(message.send_time * 1000).toISOString()}
内容: ${message.body}

【分析指示】
1. カテゴリを以下から選択:
   - "実装ノウハウ": コーディング、WordPress、ECサイト関連の技術的知見
   - "制作方針・指示出し": 実装や制作の方針に関する指示
   - "トラブル対応": エラー解決、不具合対処
   - "質疑応答・相談": 判断基準、仕様確認
   - "定型的なやりとり": 挨拶、スケジュール調整など（形式知化不要）

2. 汎用性を判定 (high/medium/low):
   - high: 他のプロジェクトでも活用できる普遍的な知見
   - medium: 一部のプロジェクトで活用できる知見
   - low: 特定のプロジェクトに固有の内容

3. タグを自動生成（技術名、業務タイプなど、3-5個程度）

4. タイトルを生成（簡潔に、20文字以内）

5. 内容を整形:
   - 文脈依存を排除し、単独で理解できる形に
   - 「これ」「それ」などの指示語を具体的な名詞に置き換え
   - 前提条件や背景も補足

【出力形式】
以下のJSON形式で返してください。それ以外は一切出力しないでください。

{
  "message_id": "${message.message_id}",
  "category": "カテゴリ名",
  "versatility": "high/medium/low",
  "title": "タイトル",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "speaker": "${message.account.name}",
  "date": "${new Date(message.send_time * 1000).toISOString()}",
  "formatted_content": "整形後の内容",
  "original_body": "${message.body.replace(/"/g, '\\"')}"
}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
