/**
 * Claude APIに送る前のメッセージフィルタリング
 * 明らかに知見が含まれないメッセージを事前除外し、API負荷を削減
 */

export interface FilterConfig {
  minLength: number;               // 最小文字数（デフォルト: 10）
  maxLength: number;               // 最大文字数（デフォルト: 300、超過分は切り詰め）
  boilerplateThreshold: number;    // 定型文除外の閾値（この文字数以上なら定型文で始まっても通す）
  noisePatterns: string[];         // ノイズパターン（常に除外：絵文字、記号、wのみ等）
  boilerplatePatterns: string[];   // 定型文パターン（短い場合のみ除外：挨拶、了解、承知等）
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  minLength: 10,  // 10文字未満は除外
  maxLength: 300, // 超過分は切り詰め
  boilerplateThreshold: 50, // 50文字以上なら定型文で始まっていても通す

  // ノイズパターン（常に除外、文字数に関係なく）
  noisePatterns: [
    '^[!！?？。、,，.・]+$',  // 記号のみ
    '^w+$',                   // wのみ
    '^ww+$',                  // ww以上
    '^[👍👌✨🙏💦😊🎉]+$',    // 絵文字のみ
  ],

  // 定型文パターン（短い場合のみ除外、prefix一致）
  boilerplatePatterns: [
    // 短い定型文
    '^了解(です|しました)?',
    '^承知(です|しました)?',
    '^確認(します|しました|お願いします)?',
    '^チェック(します|しました)?',
    '^修正(します|しました)?',
    '^対応(します|しました)?',
    '^OK',
    '^ありがとうございます?',
    '^ありがとうございました',
    '^お疲れ様です',
    '^おつかれさまです',
    '^よろしくお願いします',
    '^よろしくお願いいたします',

    // 短い返信・相槌
    '^はい',
    '^いいえ',
    '^そうですね',
    '^そうします',
    '^そうしましょう',
    '^大丈夫です',
    '^問題ないです',
    '^問題ありません',

    // Web制作チーム特有の短い返信
    '^アップ(しました|しておきました)?',
    '^デプロイ(しました|しておきました)?',
    '^プッシュ(しました|しておきました)?',
    '^コミット(しました|しておきました)?',
    '^更新(しました|しておきました)?',
    '^反映(しました|しておきました)?',
    '^完了(しました|です)?',
    '^済みです',
    '^直しました',
    '^見ました',
    '^見ておきます',
    '^確認しておきます',

    // 挨拶・時間調整
    '^おはようございます',
    '^こんにちは',
    '^お先に失礼します',
    '^戻りました',
    '^離席します',
  ],
};

export interface FilterResult {
  skip: boolean;
  reason?: string;
  truncated?: boolean;
}

/**
 * メッセージをフィルタリング判定
 */
export function shouldSkipMessage(
  body: string,
  config: Partial<FilterConfig> = {}
): FilterResult {
  const cfg = { ...DEFAULT_FILTER_CONFIG, ...config };
  const trimmed = body.trim();

  // 1. 最小文字数チェック
  if (trimmed.length < cfg.minLength) {
    return { skip: true, reason: `too_short (${trimmed.length} chars)` };
  }

  // 2. ノイズパターンチェック（常に除外、文字数に関係なく）
  for (const pattern of cfg.noisePatterns) {
    try {
      if (new RegExp(pattern, 'i').test(trimmed)) {
        return { skip: true, reason: `noise_pattern: ${pattern}` };
      }
    } catch (e) {
      console.warn(`Invalid regex pattern: ${pattern}`, e);
    }
  }

  // 3. 定型文パターンチェック（短いメッセージのみ除外）
  // boilerplateThreshold文字以上のメッセージは定型文で始まっていても通す
  // 例: 「了解です。次回からは〇〇の手順でテストします。」のようなケースを救済
  if (trimmed.length < cfg.boilerplateThreshold) {
    for (const pattern of cfg.boilerplatePatterns) {
      try {
        if (new RegExp(pattern, 'i').test(trimmed)) {
          return { skip: true, reason: `boilerplate_pattern: ${pattern}` };
        }
      } catch (e) {
        console.warn(`Invalid regex pattern: ${pattern}`, e);
      }
    }
  }

  return { skip: false };
}

/**
 * メッセージ本文を切り詰め（長すぎる場合）
 * @param body メッセージ本文
 * @param maxLength 最大文字数（suffix含めてこの長さ以下にする）
 */
export function truncateMessage(
  body: string,
  maxLength: number = 300  // DEFAULT_FILTER_CONFIG.maxLength に統一
): { body: string; truncated: boolean } {
  if (body.length <= maxLength) {
    return { body, truncated: false };
  }

  const suffix = '…（以下省略）';
  const targetLength = maxLength - suffix.length; // suffix分を差し引く

  // 文の途中で切れないよう、最後の句点・改行で切る
  const truncated = body.substring(0, targetLength);
  const lastPeriod = Math.max(
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('\n'),
    truncated.lastIndexOf('、')
  );

  const cutPoint = lastPeriod > targetLength * 0.7 ? lastPeriod + 1 : targetLength;

  return {
    body: body.substring(0, cutPoint).trim() + suffix,
    truncated: true,
  };
}

/**
 * メッセージ配列全体をフィルタリング（統計情報も返す）
 */
export interface FilterStats {
  total: number;
  skipped: number;
  truncated: number;
  reasons: Record<string, number>;
}

export function filterMessages<T extends { body: string }>(
  messages: T[],
  config: Partial<FilterConfig> = {}
): { filtered: T[]; stats: FilterStats } {
  const cfg = { ...DEFAULT_FILTER_CONFIG, ...config };
  const stats: FilterStats = {
    total: messages.length,
    skipped: 0,
    truncated: 0,
    reasons: {},
  };

  const filtered: T[] = [];

  for (const msg of messages) {
    // スキップ判定
    const skipResult = shouldSkipMessage(msg.body, cfg);

    if (skipResult.skip) {
      stats.skipped++;
      const reason = skipResult.reason || 'unknown';
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      continue;
    }

    // 切り詰め処理
    const { body, truncated } = truncateMessage(msg.body, cfg.maxLength);

    if (truncated) {
      stats.truncated++;
      // 切り詰めた内容でメッセージを更新
      filtered.push({ ...msg, body });
    } else {
      filtered.push(msg);
    }
  }

  return { filtered, stats };
}
