import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ChatworkMessage } from '../chatwork/client.js';
import type { ResolvedRole, TeamRole } from '../team/profiles.js';
import { Logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 環境変数から最大トークン数を取得（デフォルト: 2000）
// 注: dotenv.config() より前にモジュールが評価される可能性があるため、関数として定義
function getMaxTokens(): number {
  return parseInt(process.env.CLAUDE_MAX_TOKENS || '2000', 10);
}

export interface AnalyzedMessage {
  message_id: string;
  category: string;
  versatility: 'high' | 'medium' | 'low' | 'exclude';
  title: string;
  tags: string[];
  date: string;
  formatted_content: string;
}

export interface AnalyzerOptions {
  promptTemplatePath?: string;
  feedbackPath?: string;
  model?: string;
  apiMode?: 'batch' | 'realtime'; // API種別の選択
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
  private apiMode: 'batch' | 'realtime';
  private feedbackExamples: FeedbackCorrection[] = [];
  private logger: Logger;

  constructor(apiKey: string, options: AnalyzerOptions = {}) {
    this.logger = new Logger('Claude');
    this.client = new Anthropic({ apiKey });
    this.model = options.model || DEFAULT_MODEL;
    this.apiMode = options.apiMode || 'batch'; // デフォルトはbatch（後方互換性）
    this.loadPromptTemplate(options.promptTemplatePath);
    this.loadFeedback(options.feedbackPath);

    // デバッグ: max_tokens設定を表示
    const maxTokens = getMaxTokens();
    this.logger.debug(`Max tokens for analysis: ${maxTokens} (env: "${process.env.CLAUDE_MAX_TOKENS || 'not set'}")`);
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
      this.logger.info(`カスタムプロンプト読み込み: ${customPath}`);
      return;
    }

    // デフォルトパス（プロジェクトルート/prompts/analysis.md）を探す
    const projectRoot = join(__dirname, '..', '..');
    const defaultPath = join(projectRoot, 'prompts', 'analysis.md');

    if (existsSync(defaultPath)) {
      this.promptTemplate = readFileSync(defaultPath, 'utf-8');
      this.logger.info(`プロンプトテンプレート読み込み: ${defaultPath}`);
    } else {
      this.logger.info('デフォルトプロンプトを使用');
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
        this.logger.info(`フィードバック読み込み: ${this.feedbackExamples.length}件の修正例`);
      } catch (e) {
        this.logger.error(`フィードバック読み込みエラー: ${feedbackPath}`);
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
    this.logger.info(`Batch API処理開始: ${messages.length}件のメッセージ`);

    // Batch API用のリクエストを作成
    const requests = messages.map((msg, index) => ({
      custom_id: `msg_${msg.message_id}`,
      params: {
        model: this.model,
        max_tokens: getMaxTokens(),
        messages: [{
          role: 'user' as const,
          content: this.createAnalysisPrompt(msg, roleResolver)
        }]
      }
    }));

    // Batch作成
    this.logger.info(`Batch作成リクエスト送信中...`);
    const batchCreateStartTime = Date.now();

    const batch = await this.client.beta.messages.batches.create({
      requests
    });

    const batchCreateElapsed = Date.now() - batchCreateStartTime;
    this.logger.info(`Batch作成完了: ${batch.id} (作成時間: ${batchCreateElapsed}ms)`);
    this.logger.info(`ステータス: ${batch.processing_status}`);
    this.logger.info(`リクエスト数: ${requests.length}件`);

    // created_atとexpires_atを表示
    if (batch.created_at) {
      const createdAt = new Date(batch.created_at);
      this.logger.info(`作成日時: ${createdAt.toLocaleString('ja-JP')}`);
    }
    if (batch.expires_at) {
      const expiresAt = new Date(batch.expires_at);
      this.logger.info(`有効期限: ${expiresAt.toLocaleString('ja-JP')}`);
    }

    // Batch完了を待機
    const completedBatch = await this.waitForBatchCompletion(batch.id);
    
    // 結果を取得
    const results = await this.client.beta.messages.batches.results(completedBatch.id);

    // custom_idからmessage_idを抽出するマップを作成
    const messageIdMap = new Map<string, string>();
    for (const msg of messages) {
      messageIdMap.set(`msg_${msg.message_id}`, msg.message_id);
    }

    // dateを生成するマップを作成
    const messageDateMap = new Map<string, string>();
    for (const msg of messages) {
      const date = new Date(msg.send_time * 1000).toISOString();
      messageDateMap.set(`msg_${msg.message_id}`, date);
    }

    // 結果をパース
    this.logger.info(`結果を取得中...`);
    const analyzed: AnalyzedMessage[] = [];
    let parseErrorCount = 0;
    let processedCount = 0;

    for await (const result of results) {
      processedCount++;
      if (result.result.type === 'succeeded') {
        const content = result.result.message.content[0];
        if (content.type === 'text') {
          try {
            // custom_idからmessage_idを取得
            const messageId = messageIdMap.get(result.custom_id);
            const date = messageDateMap.get(result.custom_id);

            if (!messageId || !date) {
              this.logger.error(`custom_id ${result.custom_id} に対応するメッセージが見つかりません`);
              parseErrorCount++;
              continue;
            }

            // JSONを抽出してパース（複数パターンに対応）
            let jsonText = content.text.trim();

            // パターン1: ```json ... ``` 形式
            let jsonMatch = jsonText.match(/```json\s*([\s\S]*?)```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1].trim();
            } else {
              // パターン2: ``` ... ``` 形式（json指定なし）
              jsonMatch = jsonText.match(/```\s*([\s\S]*?)```/);
              if (jsonMatch) {
                jsonText = jsonMatch[1].trim();
              }
            }

            // JSON文字列がまだ```で始まっている場合は除去（念のため）
            jsonText = jsonText.replace(/^```(json)?/gm, '').replace(/```$/gm, '').trim();

            const parsed = JSON.parse(jsonText);

            // 配列形式の応答に対応（1つのメッセージから複数の知見を抽出する場合）
            const items = Array.isArray(parsed) ? parsed : [parsed];

            for (const item of items) {
              // 必須フィールドのバリデーション（message_idは不要）
              if (!item.versatility || !item.category) {
                this.logger.warn(`必須フィールド不足をスキップ: ${result.custom_id}`, item);
                parseErrorCount++;
                continue;
              }

              // メタデータを追加
              analyzed.push({
                ...item,
                message_id: messageId,
                date: date
              } as AnalyzedMessage);
            }
          } catch (e) {
            parseErrorCount++;
            const error = e instanceof Error ? e : new Error(String(e));
            const errorMsg = error.message;

            // エラー種別の判定と対処方法の提示
            let errorType = 'unknown';
            let suggestion = '';

            const currentMaxTokens = getMaxTokens();
            if (errorMsg.includes('Unterminated string') || errorMsg.includes('Unexpected end of JSON')) {
              errorType = 'truncated';
              suggestion = `\n  💡 対処方法: .envファイルで CLAUDE_MAX_TOKENS を増やしてください\n     現在値: ${currentMaxTokens}\n     推奨値: ${currentMaxTokens + 500}`;
            } else if (errorMsg.includes('Unexpected token')) {
              errorType = 'format';
              suggestion = '\n  💡 対処方法: JSON形式が不正です。プロンプトの指示を確認してください';
            } else {
              suggestion = '\n  💡 対処方法: JSONパースに失敗しました。応答内容を確認してください';
            }

            this.logger.error(`\n❌ JSON parse error for ${result.custom_id}`);
            this.logger.error(`Error type: ${errorType}`);
            this.logger.error(`Error: ${errorMsg}`, error);
            this.logger.error(`Response length: ${content.text.length} chars`);
            this.logger.error(`Current max_tokens: ${currentMaxTokens} (env var: "${process.env.CLAUDE_MAX_TOKENS || 'not set'}")${suggestion}`);
            this.logger.error(`Raw response (first 1000 chars):\n${content.text.substring(0, 1000)}`);

            if (content.text.length > 1000) {
              this.logger.error(`Raw response (last 500 chars):\n${content.text.substring(content.text.length - 500)}`);
            }
            this.logger.error(''); // 空行
          }
        }
      } else if (result.result.type === 'errored') {
        parseErrorCount++;
        this.logger.error(`API error for ${result.custom_id}: ${result.result.error.error.type}`);
        if ('message' in result.result.error.error) {
          this.logger.error(`Error message: ${result.result.error.error.message}`);
        }
      } else {
        parseErrorCount++;
        this.logger.error(`Unexpected result type for ${result.custom_id}: ${result.result.type}`);
      }
    }

    if (parseErrorCount > 0) {
      this.logger.warn(`\n${parseErrorCount}/${processedCount}件の処理に失敗しました`);
    }

    this.logger.info(`分析完了: ${analyzed.length}件`);
    return analyzed;
  }

  /**
   * Realtime APIでメッセージを分析
   * 通常価格だが、高速（数秒〜数分）
   */
  async analyzeRealtime(messages: ChatworkMessage[], roleResolver?: (accountId: number) => ResolvedRole): Promise<AnalyzedMessage[]> {
    this.logger.info(`Realtime API処理開始: ${messages.length}件のメッセージ`);
    this.logger.info(`並列実行数: 5件ずつ`);

    const analyzed: AnalyzedMessage[] = [];
    let parseErrorCount = 0;
    const CONCURRENCY = 5; // 並列実行数（API制限を考慮）

    const startTime = Date.now();

    // 5件ずつ並列処理
    for (let i = 0; i < messages.length; i += CONCURRENCY) {
      const batch = messages.slice(i, i + CONCURRENCY);
      const batchNum = Math.floor(i / CONCURRENCY) + 1;
      const totalBatches = Math.ceil(messages.length / CONCURRENCY);

      this.logger.info(`バッチ ${batchNum}/${totalBatches} 処理中 (${batch.length}件)...`);

      const promises = batch.map(async (msg) => {
        try {
          const response = await this.client.messages.create({
            model: this.model,
            max_tokens: getMaxTokens(),
            messages: [{
              role: 'user',
              content: this.createAnalysisPrompt(msg, roleResolver)
            }]
          });

          const content = response.content[0];
          if (content.type === 'text') {
            // JSONを抽出してパース（複数パターンに対応）
            let jsonText = content.text.trim();

            // パターン1: ```json ... ``` 形式
            let jsonMatch = jsonText.match(/```json\s*([\s\S]*?)```/);
            if (jsonMatch) {
              jsonText = jsonMatch[1].trim();
            } else {
              // パターン2: ``` ... ``` 形式（json指定なし）
              jsonMatch = jsonText.match(/```\s*([\s\S]*?)```/);
              if (jsonMatch) {
                jsonText = jsonMatch[1].trim();
              }
            }

            // JSON文字列がまだ```で始まっている場合は除去（念のため）
            jsonText = jsonText.replace(/^```(json)?/gm, '').replace(/```$/gm, '').trim();

            try {
              const parsed = JSON.parse(jsonText);

              // 配列形式の応答に対応（1つのメッセージから複数の知見を抽出する場合）
              const items = Array.isArray(parsed) ? parsed : [parsed];

              // メタデータを準備
              const messageId = msg.message_id;
              const date = new Date(msg.send_time * 1000).toISOString();

              // 必須フィールドのバリデーション
              const validItems: AnalyzedMessage[] = [];
              for (const item of items) {
                // 必須フィールドチェック（message_idは不要）
                if (!item.versatility || !item.category) {
                  this.logger.warn(`必須フィールド不足をスキップ: ${msg.message_id}`, item);
                  continue;
                }

                // メタデータを追加
                validItems.push({
                  ...item,
                  message_id: messageId,
                  date: date
                } as AnalyzedMessage);
              }

              if (validItems.length === 0) {
                return { success: false, messageId: msg.message_id, error: new Error('No valid items after validation') };
              }

              return { success: true, data: validItems, messageId: msg.message_id };
            } catch (parseError) {
              const error = parseError instanceof Error ? parseError : new Error(String(parseError));
              const errorMsg = error.message;

              // エラー種別の判定と対処方法の提示
              let errorType = 'unknown';
              let suggestion = '';
              const currentMaxTokens = getMaxTokens();

              if (errorMsg.includes('Unterminated string') || errorMsg.includes('Unexpected end of JSON')) {
                errorType = 'truncated';
                suggestion = `\n  💡 対処方法: .envファイルで CLAUDE_MAX_TOKENS を増やしてください\n     現在値: ${currentMaxTokens}\n     推奨値: ${currentMaxTokens + 500}`;
              } else if (errorMsg.includes('Unexpected token')) {
                errorType = 'format';
                suggestion = '\n  💡 対処方法: JSON形式が不正です。プロンプトの指示を確認してください';
              } else {
                suggestion = '\n  💡 対処方法: JSONパースに失敗しました。応答内容を確認してください';
              }

              this.logger.error(`\n❌ JSON parse error for message ${msg.message_id}`);
              this.logger.error(`Error type: ${errorType}`);
              this.logger.error(`Parse error: ${errorMsg}`, error);
              this.logger.error(`Response length: ${content.text.length} chars`);
              this.logger.error(`Current max_tokens: ${currentMaxTokens} (env var: "${process.env.CLAUDE_MAX_TOKENS || 'not set'}")${suggestion}`);
              this.logger.error(`Raw response (first 1000 chars):\n${content.text.substring(0, 1000)}`);

              if (content.text.length > 1000) {
                this.logger.error(`Raw response (last 500 chars):\n${content.text.substring(content.text.length - 500)}`);
              }
              this.logger.error(''); // 空行
              return { success: false, messageId: msg.message_id, error: parseError };
            }
          }
        } catch (e) {
          this.logger.error(`API error for message ${msg.message_id}: ${e instanceof Error ? e.message : String(e)}`);
          return { success: false, messageId: msg.message_id, error: e };
        }
        return { success: false, messageId: msg.message_id };
      });

      const results = await Promise.all(promises);

      for (const result of results) {
        if (result.success && 'data' in result && result.data) {
          // 配列形式の応答に対応（1つのメッセージから複数の知見）
          if (Array.isArray(result.data)) {
            analyzed.push(...result.data);
          } else {
            analyzed.push(result.data);
          }
        } else {
          parseErrorCount++;
        }
      }

      // 進捗表示
      const progress = Math.min(i + CONCURRENCY, messages.length);
      const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
      this.logger.info(`進捗: ${progress}/${messages.length}件 (経過: ${elapsedSec}秒)`);
    }

    const totalElapsedSec = Math.floor((Date.now() - startTime) / 1000);
    this.logger.info(`処理完了: ${analyzed.length}件 (総時間: ${totalElapsedSec}秒)`);

    if (parseErrorCount > 0) {
      this.logger.warn(`\n${parseErrorCount}/${messages.length}件の処理に失敗しました`);
    }

    return analyzed;
  }

  /**
   * メッセージを分析（API種別に応じて自動振り分け）
   */
  async analyze(messages: ChatworkMessage[], roleResolver?: (accountId: number) => ResolvedRole): Promise<AnalyzedMessage[]> {
    if (this.apiMode === 'realtime') {
      this.logger.info('API種別: Realtime API (高速、通常価格)');
      return this.analyzeRealtime(messages, roleResolver);
    } else {
      this.logger.info('API種別: Batch API (50%割引、処理時間: 数分〜24時間)');
      return this.analyzeBatch(messages, roleResolver);
    }
  }

  /**
   * Batch完了を待機
   */
  private async waitForBatchCompletion(batchId: string): Promise<Anthropic.Beta.Messages.BetaMessageBatch> {
    const startTime = Date.now();
    const TIMEOUT_MS = 30 * 60 * 1000; // 30分でタイムアウト警告
    const POLLING_INTERVAL_MS = 10000; // 10秒ごとにチェック

    let batch = await this.client.beta.messages.batches.retrieve(batchId);

    // 送信したリクエストの総数を計算（request_countsの合計）
    const totalRequests = batch.request_counts.processing +
                         batch.request_counts.succeeded +
                         batch.request_counts.errored +
                         batch.request_counts.canceled +
                         batch.request_counts.expired;

    this.logger.info(`Batch処理待機開始 (合計: ${totalRequests}件)`);
    this.logger.info(`初期ステータス: ${batch.processing_status}`);
    this.logger.info(`詳細: processing=${batch.request_counts.processing}, succeeded=${batch.request_counts.succeeded}, errored=${batch.request_counts.errored}`);

    // expires_atを表示（24時間後に期限切れ）
    if (batch.expires_at) {
      const expiresAt = new Date(batch.expires_at);
      this.logger.info(`有効期限: ${expiresAt.toLocaleString('ja-JP')}`);
    }

    let pollCount = 0;
    let timeoutWarningShown = false; // 警告を一度だけ表示するフラグ
    while (batch.processing_status === 'in_progress') {
      pollCount++;
      const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);

      // 完了済みリクエスト数（succeeded, errored, canceled, expired を含む）
      const completedRequests = batch.request_counts.succeeded +
                               batch.request_counts.errored +
                               batch.request_counts.canceled +
                               batch.request_counts.expired;

      this.logger.info(`処理中... (完了: ${completedRequests}/${totalRequests}, 経過: ${elapsedMinutes}分)`);

      // タイムアウト警告（一度だけ表示）
      if (!timeoutWarningShown && Date.now() - startTime > TIMEOUT_MS) {
        this.logger.warn(`\nBatch処理が30分以上経過しています`);
        this.logger.warn(`Batch ID: ${batchId}`);
        this.logger.warn(`現在のステータス: processing=${batch.request_counts.processing}, succeeded=${batch.request_counts.succeeded}, errored=${batch.request_counts.errored}`);
        this.logger.warn(`Anthropic Batch APIは通常24時間以内に完了しますが、異常に遅い場合はAPI制限やシステム障害の可能性があります`);
        this.logger.warn(`https://status.anthropic.com/ でAPIステータスを確認してください\n`);
        timeoutWarningShown = true;
      }

      await this.sleep(POLLING_INTERVAL_MS);
      batch = await this.client.beta.messages.batches.retrieve(batchId);
    }

    const totalElapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
    console.log(`\n[Claude] Batch完了: ${batch.processing_status} (処理時間: ${totalElapsedMinutes}分)`);
    this.logger.info(`成功: ${batch.request_counts.succeeded}, 失敗: ${batch.request_counts.errored}`);

    if (batch.request_counts.errored > 0) {
      this.logger.warn(`${batch.request_counts.errored}件のリクエストが失敗しました`);
    }

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
        .replace(/\{\{speaker\}\}/g, roleLabel)  // 実名ではなくロールラベルのみ
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
発言者ロール: ${roleLabel}
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
  "category": "カテゴリ名",
  "versatility": "high/medium/low/exclude",
  "title": "タイトル",
  "tags": ["タグ1", "タグ2", "タグ3"],
  "formatted_content": "整形後の内容"
}`;
  }

  /**
   * ロールに応じた分析指示を生成
   */
  private buildRoleInstruction(role: TeamRole): string {
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
