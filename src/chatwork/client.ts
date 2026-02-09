import fetch from 'node-fetch';
import { MessageCacheManager } from '../cache/messages.js';

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

export class ChatworkClient {
  private apiToken: string;
  private baseUrl = 'https://api.chatwork.com/v2';
  private cacheManager: MessageCacheManager;

  constructor(apiToken: string, cacheDir: string = './cache') {
    this.apiToken = apiToken;
    this.cacheManager = new MessageCacheManager(cacheDir);
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
    console.log(`[Chatwork API] レート制限: ${remaining}/${limit}`);

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
  async getAllMessages(roomId: string, maxMessages: number = 500): Promise<ChatworkMessage[]> {
    // キャッシュの統計情報を表示
    await this.cacheManager.showStats(roomId);

    // 既存キャッシュを読み込み
    const existingCache = await this.cacheManager.load(roomId);
    const isFirstRun = !existingCache;

    if (isFirstRun) {
      console.log(`[Chatwork] 初回実行: 最新100件を取得します`);
    } else {
      console.log(`[Chatwork] 差分取得: キャッシュに${existingCache.messages.length}件あり`);
    }

    // メッセージ取得
    // 初回はforce=1、2回目以降はforce=0で差分取得
    const force = isFirstRun ? 1 : 0;
    const newMessages = await this.getMessages(roomId, force);

    console.log(`[Chatwork] API取得: ${newMessages.length}件`);

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
      console.log(`[Chatwork] ${maxMessages}件に制限`);
      allMessages = allMessages.slice(0, maxMessages);
    }

    console.log(`[Chatwork] 合計: ${allMessages.length}件`);
    return allMessages;
  }

  /**
   * 期間を指定してメッセージをフィルタ
   */
  filterByDateRange(messages: ChatworkMessage[], daysBack: number): ChatworkMessage[] {
    const cutoffTime = Math.floor(Date.now() / 1000) - (daysBack * 24 * 60 * 60);
    return messages.filter(msg => msg.send_time >= cutoffTime);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
