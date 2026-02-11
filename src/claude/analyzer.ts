import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ChatworkMessage } from '../chatwork/client.js';
import type { ResolvedRole } from '../team/profiles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface AnalyzedMessage {
  message_id: string;
  category: string;
  versatility: 'high' | 'medium' | 'low' | 'exclude';
  title: string;
  tags: string[];
  speaker: string;
  speaker_role?: string;
  date: string;
  formatted_content: string;
}

export interface AnalyzerOptions {
  promptTemplatePath?: string;
  feedbackPath?: string;
  model?: string;
}

export interface FeedbackCorrection {
  example: string;
  wrong_level: string;
  correct_level: string;
  reason: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

export class ClaudeAnalyzer {
  private client: Anthropic;
  private promptTemplate: string | null = null;
  private model: string;
  private feedbackExamples: FeedbackCorrection[] = [];

  constructor(apiKey: string, options: AnalyzerOptions = {}) {
    this.client = new Anthropic({ apiKey });
    this.model = options.model || DEFAULT_MODEL;
    this.loadPromptTemplate(options.promptTemplatePath);
    this.loadFeedback(options.feedbackPath);
  }

  /**
   * 使用モデル名を取得
   */
  getModel(): string {
    return this.model;
  }

  /**
   * プロンプトテンプレートを読み込む
   */
  private loadPromptTemplate(customPath?: string): void {
    // カスタムパスが指定されている場合
    if (customPath && existsSync(customPath)) {
      this.promptTemplate = readFileSync(customPath, 'utf-8');
      console.log(`[Claude] カスタムプロンプト読み込み: ${customPath}`);
      return;
    }

    // デフォルトパス（プロジェクトルート/prompts/analysis.md）を探す
    const projectRoot = join(__dirname, '..', '..');
    const defaultPath = join(projectRoot, 'prompts', 'analysis.md');

    if (existsSync(defaultPath)) {
      this.promptTemplate = readFileSync(defaultPath, 'utf-8');
      console.log(`[Claude] プロンプトテンプレート読み込み: ${defaultPath}`);
    } else {
      console.log('[Claude] デフォルトプロンプトを使用');
    }
  }

  /**
   * フィードバックファイルを読み込む
   */
  private loadFeedback(customPath?: string): void {
    const projectRoot = join(__dirname, '..', '..');
    const feedbackPath = customPath || join(projectRoot, 'feedback', 'corrections.json');

    if (existsSync(feedbackPath)) {
      try {
        const content = readFileSync(feedbackPath, 'utf-8');
        this.feedbackExamples = JSON.parse(content);
        console.log(`[Claude] フィードバック読み込み: ${this.feedbackExamples.length}件の修正例`);
      } catch (e) {
        console.error(`[Claude] フィードバック読み込みエラー: ${feedbackPath}`);
      }
    }
  }

  /**
   * フィードバック例をプロンプト用テキストに変換
   */
  private formatFeedbackExamples(): string {
    if (this.feedbackExamples.length === 0) {
      return '';
    }

    let text = '\n【過去の修正例（これらを参考に判定してください）】\n';
    for (const fb of this.feedbackExamples) {
      text += `- "${fb.example}" → ${fb.wrong_level}ではなく${fb.correct_level}（理由: ${fb.reason}）\n`;
    }
    return text;
  }

  /**
   * Batch APIでメッセージを分析
   * 50%割引が適用される
   */
  async analyzeBatch(messages: ChatworkMessage[], roleResolver?: (accountId: number) => ResolvedRole): Promise<AnalyzedMessage[]> {
    console.log(`[Claude] Batch API処理開始: ${messages.length}件のメッセージ`);

    // Batch API用のリクエストを作成
    const requests = messages.map((msg, index) => ({
      custom_id: `msg_${msg.message_id}`,
      params: {
        model: this.model,
        max_tokens: 1000,
        messages: [{
          role: 'user' as const,
          content: this.createAnalysisPrompt(msg, roleResolver)
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
  private createAnalysisPrompt(message: ChatworkMessage, roleResolver?: (accountId: number) => ResolvedRole): string {
    const date = new Date(message.send_time * 1000).toISOString();

    const feedbackText = this.formatFeedbackExamples();

    // ロール情報を解決
    const resolved = roleResolver?.(message.account.account_id);
    const roleLabel = resolved?.roleLabel ?? 'Member';
    const role = resolved?.role ?? 'member';
    const roleInstruction = this.buildRoleInstruction(role);

    // 外部テンプレートがある場合はプレースホルダーを置換
    if (this.promptTemplate) {
      return this.promptTemplate
        .replace(/\{\{message_id\}\}/g, message.message_id)
        .replace(/\{\{speaker\}\}/g, message.account.name)
        .replace(/\{\{speaker_role\}\}/g, role)
        .replace(/\{\{speaker_role_label\}\}/g, roleLabel)
        .replace(/\{\{role_instruction\}\}/g, roleInstruction)
        .replace(/\{\{date\}\}/g, date)
        .replace(/\{\{body\}\}/g, message.body)
        .replace(/\{\{feedback_examples\}\}/g, feedbackText);
    }

    // デフォルトプロンプト（フォールバック）
    return `あなたはWeb制作チームのチャット履歴から**汎用的な**形式知を抽出するアシスタントです。

【重要】案件固有の内容は除外し、他の案件でも活用できる知見のみを抽出してください。
${roleInstruction}
以下のメッセージを分析し、JSON形式で結果を返してください。

【メッセージ】
発言者: ${message.account.name} (Role: ${roleLabel})
日時: ${date}
内容: ${message.body}

【分析指示】

1. カテゴリを以下から選択:
   - "実装ノウハウ": コーディング、WordPress、ECサイト関連の技術的知見
   - "制作方針・指示出し": 実装や制作の方針に関する普遍的な知見
   - "トラブル対応": エラー解決、不具合対処の汎用的な方法
   - "質疑応答・相談": 判断基準、仕様確認の汎用的なパターン
   - "除外対象": 上記に該当しない、または案件固有の内容

2. 汎用性を**4段階で厳格に**判定:

   **high** - 普遍的な技術知見（どの案件でも確実に活用可能）
   例1: "WordPressの本番環境では、WP_DEBUGをfalseに設定し、デバッグログを無効化する"
   例2: "CSSアニメーションではtransformを使うとrepaintを発生させないため高速"
   ※技術的理由や原則が明確で、どの案件でも応用できる

   **medium** - 業界・技術領域特有の知見
   例1: "不動産サイトでは物件詳細ページにGoogleマップ埋め込みが必須"
   例2: "BtoB製造業サイトでは製品カタログPDFダウンロード機能が重視される"
   ※特定の業界・用途でのパターンや傾向

   **low** - ケースバイケースだが参考になる判断例
   例1: "クライアントが気に入っている競合サイトの雰囲気は、デザイン提案に反映すべき"
   例2: "素材が未確定の段階では、ダミーで仮配置し、確定後に調整する"
   ※案件ごとに状況は異なるが、判断の参考になる

   **exclude** - 案件固有の指示・定型文（カテゴリを「除外対象」に設定）
   例1: "トップページのヒーローエリアは高さ600pxで固定"
   例2: "メインカラーは#3498db、サブカラーは#e74c3c"
   例3: "了解しました。対応します"
   ※具体的な数値、色、固有名詞を含む個別指示、または挨拶・確認などの定型文

【判定の鉄則】
- 具体的な数値・色コード・固有名詞が中心 → exclude
- 「この案件では」「今回は」という限定表現 → exclude
- 挨拶・確認・スケジュール調整 → exclude
- 技術的理由や原則の説明がある → high
- 業界特有のパターン・傾向 → medium
- 状況判断の考え方・アプローチ → low
${feedbackText}
3. タグを自動生成（技術名、業務タイプなど、3-5個程度）
   ※標準的な技術用語を使用（WordPress、CSS、JavaScript、SEO、デザインレビューなど）

4. タイトルを生成（簡潔に、20文字以内）

5. 内容を整形:
   - 案件固有の要素（案件名、クライアント名等）を削除または一般化
   - 文脈依存を排除し、単独で理解できる形に
   - 「これ」「それ」などの指示語を具体的な名詞に置き換え
   - 前提条件や背景も補足

6. 【必須】機密情報・個人情報の除去:
   formatted_contentには以下の情報を**絶対に含めないでください**:
   - 個人名・担当者名（「田中さんが」→「担当者が」のように一般化）
   - メールアドレス・電話番号・住所
   - 社名・クライアント名・案件名（「A社の案件」→「クライアント案件」のように一般化）
   - URL・IPアドレス・ドメイン名（技術解説に必要な一般的なURL例は除く）
   - パスワード・APIキー・トークン等の認証情報
   - 社内システムのパス・内部サーバー名
   - 金額・見積もり・契約に関する具体的数値
   上記が含まれる場合は一般的な表現に置き換えるか、知見の本質に関係なければ削除してください。

【出力形式】
以下のJSON形式で返してください。それ以外は一切出力しないでください。

{
  "message_id": "${message.message_id}",
  "category": "カテゴリ名",
  "versatility": "high/medium/low/exclude",
  "title": "タイトル",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "speaker": "${message.account.name}",
  "speaker_role": "${role}",
  "date": "${date}",
  "formatted_content": "整形後の内容"
}`;
  }

  /**
   * ロールに応じた分析指示を生成
   */
  private buildRoleInstruction(role: string): string {
    switch (role) {
      case 'senior':
        return `
【発言者ロールに基づく分析指示】
この発言者はSenior（経験豊富なシニアメンバー）です。
- 発言内容を「標準（Standard）」として扱ってください。
- 背景にある理由や原則を深く掘り下げ、汎用性を高く見積もってください。
- 技術的な判断や方針は、長期的な保守性やリスクを予見した上での知見である可能性が高いです。
`;
      case 'junior':
        return `
【発言者ロールに基づく分析指示】
この発言者はJunior（経験の浅いメンバー）です。
- 発言内容を「事例（Case Study）」として扱ってください。
- 内容が技術的に正しいか、偏っていないかを厳しく検証してください。
- 暫定的な対応や場当たり的な解決策でないか注意深く判断してください。
- 疑わしい場合は、汎用性を低めに判定してください。
`;
      default:
        return '';
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
