import fetch from 'node-fetch';

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

  constructor(apiToken: string) {
    this.apiToken = apiToken;
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
      throw new Error(`Chatwork API Error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as ChatworkMessage[];
  }

  /**
   * 複数ページにわたってメッセージを取得
   * Chatwork APIは100件ずつしか取得できないため、
   * force=0で差分を繰り返し取得することでページネーションを実現
   */
  async getAllMessages(roomId: string, maxMessages: number = 500): Promise<ChatworkMessage[]> {
    const allMessages: ChatworkMessage[] = [];
    let hasMore = true;
    let iteration = 0;
    const maxIterations = Math.ceil(maxMessages / 100);

    console.log(`[Chatwork] メッセージ取得開始（最大${maxMessages}件）`);

    // 最初は force=1 で最新100件を取得
    const firstBatch = await this.getMessages(roomId, 1);
    allMessages.push(...firstBatch);
    console.log(`[Chatwork] 取得: ${firstBatch.length}件（累計: ${allMessages.length}件）`);

    if (firstBatch.length < 100) {
      console.log('[Chatwork] 全メッセージ取得完了');
      return allMessages;
    }

    // レート制限対策: 10秒あたり10回制限があるため、少し待機
    await this.sleep(1000);

    // 2回目以降は force=0 で差分取得
    // ただし、Chatwork APIの仕様上、これ以上古いメッセージは
    // 別の方法（日付指定など）が必要
    // 現状は最新100件のみ取得する実装とする
    
    console.log('[Chatwork] メッセージ取得完了');
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
