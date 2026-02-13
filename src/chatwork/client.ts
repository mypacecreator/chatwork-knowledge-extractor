import fetch from 'node-fetch';
import { MessageCacheManager } from '../cache/messages.js';
import { Logger } from '../utils/logger.js';

export interface ChatworkMessage {
  message_id: string;
  account: {
    account_id: number;
    name: string;
    avatar_image_url: string;
  };
  body: string;
  send_time: number;
  update_time: number;
}

export interface FetchResult {
  messages: ChatworkMessage[];
  warnings: string[];
  isFirstRun: boolean;
  apiMessageCount: number;
}

export interface RoomInfo {
  room_id: number;
  name: string;
  type: 'my' | 'direct' | 'group';
  icon_path: string;
  description: string;
}

export class ChatworkClient {
  private apiToken: string;
  private baseUrl = 'https://api.chatwork.com/v2';
  private cacheManager: MessageCacheManager;
  private logger: Logger;

  constructor(apiToken: string, cacheDir: string = './cache') {
    this.apiToken = apiToken;
    this.cacheManager = new MessageCacheManager(cacheDir);
    this.logger = new Logger('Chatwork');
  }

  /**
   * ルーム情報を取得
   */
  async getRoomInfo(roomId: string): Promise<RoomInfo> {
    const url = `${this.baseUrl}/rooms/${roomId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-chatworktoken': this.apiToken,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Chatwork API Error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as RoomInfo;
  }

  /**
   * 指定したルームのメッセージを取得
   * force=1で最新100件、force=0で前回取得以降の差分
   */
  async getMessages(roomId: string, force: 0 | 1 = 1): Promise<ChatworkMessage[]> {
    const url = `${this.baseUrl}/rooms/${roomId}/messages?force=${force}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-chatworktoken': this.apiToken,
        'Accept': 'application/json'
      }
    });

    // レート制限情報をログ出力
    const remaining = response.headers.get('x-ratelimit-remaining');
    const limit = response.headers.get('x-ratelimit-limit');
    this.logger.info(`API レート制限: ${remaining}/${limit}`);

    if (!response.ok) {
      // 204 No Content は空配列を返す
      if (response.status === 204) {
        return [];
      }
      throw new Error(`Chatwork API Error: ${response.status} ${response.statusText}`);
    }

    // 204の場合はjsonがないので空配列
    const text = await response.text();
    if (!text) {
      return [];
    }

    return JSON.parse(text) as ChatworkMessage[];
  }

  /**
   * キャッシュを活用してメッセージを取得
   * 初回: force=1で最新100件を取得してキャッシュ
   * 2回目以降: force=0で差分取得してキャッシュにマージ
   */
  async getAllMessages(roomId: string, maxMessages: number = 500): Promise<FetchResult> {
    const warnings: string[] = [];

    // キャッシュの統計情報を表示
    await this.cacheManager.showStats(roomId);

    // 既存キャッシュを読み込み
    const existingCache = await this.cacheManager.load(roomId);
    const isFirstRun = !existingCache;

    if (isFirstRun) {
      this.logger.info(`初回実行: 最新100件を取得します`);
    } else {
      this.logger.info(`差分取得: キャッシュに${existingCache.messages.length}件あり`);
    }

    // メッセージ取得
    // 初回はforce=1、2回目以降はforce=0で差分取得
    const force = isFirstRun ? 1 : 0;
    const newMessages = await this.getMessages(roomId, force);
    const apiMessageCount = newMessages.length;

    this.logger.info(`API取得: ${apiMessageCount}件`);

    // 100件制限の警告チェック
    if (apiMessageCount >= 100) {
      if (isFirstRun) {
        warnings.push(
          '⚠️ 初回取得で100件の上限に達しました。これより古いメッセージは取得できません。' +
          '定期的に実行することで、今後の新規メッセージを蓄積できます。'
        );
      } else {
        warnings.push(
          '⚠️ 差分取得で100件の上限に達しました。前回実行から期間が空いたため、' +
          '一部のメッセージを取りこぼしている可能性があります。'
        );
      }
    }

    // マージ
    let allMessages: ChatworkMessage[];
    if (isFirstRun) {
      allMessages = newMessages;
    } else {
      allMessages = this.cacheManager.mergeMessages(
        existingCache.messages,
        newMessages
      );
    }

    // キャッシュを保存
    await this.cacheManager.save(roomId, allMessages);

    // maxMessagesで制限
    if (allMessages.length > maxMessages) {
      this.logger.info(`${maxMessages}件に制限`);
      allMessages = allMessages.slice(0, maxMessages);
    }

    this.logger.info(`合計: ${allMessages.length}件`);

    return {
      messages: allMessages,
      warnings,
      isFirstRun,
      apiMessageCount
    };
  }

  /**
   * 期間を指定してメッセージをフィルタ（日数指定）
   */
  filterByDateRange(messages: ChatworkMessage[], daysBack: number): ChatworkMessage[] {
    const cutoffTime = Math.floor(Date.now() / 1000) - (daysBack * 24 * 60 * 60);
    return messages.filter(msg => msg.send_time >= cutoffTime);
  }

  /**
   * EXTRACT_FROM形式でメッセージをフィルタ
   * - 数字: 過去N日間
   * - 日付形式（YYYY-MM-DD）: 指定日以降
   */
  filterByExtractFrom(messages: ChatworkMessage[], extractFrom: string): { messages: ChatworkMessage[]; description: string } {
    // 日付形式かどうかをチェック（YYYY-MM-DD）
    const dateMatch = extractFrom.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (dateMatch) {
      // 日付形式の場合（ローカル日付の0時として解釈）
      const [, year, month, day] = dateMatch;
      const fromDate = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
      const cutoffTime = Math.floor(fromDate.getTime() / 1000);
      const filtered = messages.filter(msg => msg.send_time >= cutoffTime);
      return {
        messages: filtered,
        description: `${extractFrom}以降`
      };
    } else {
      // 数字（日数）の場合
      const days = parseInt(extractFrom, 10);
      if (isNaN(days)) {
        this.logger.warn(`EXTRACT_FROM の形式が不正です: ${extractFrom}`);
        return { messages, description: '全期間' };
      }
      const filtered = this.filterByDateRange(messages, days);
      return {
        messages: filtered,
        description: `過去${days}日`
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
