import Anthropic from '@anthropic-ai/sdk';

/**
 * Claude APIエラーをわかりやすいメッセージに変換
 */
export function formatApiError(e: unknown): string {
  if (e instanceof Anthropic.APIConnectionError) {
    return [
      'Claude APIへの接続に失敗しました（ネットワークエラー）',
      '  考えられる原因:',
      '  - インターネット接続が切れている',
      '  - Claude APIが一時的に停止している',
      '  対処方法:',
      '  - インターネット接続を確認してください',
      '  - https://status.anthropic.com/ でAPIステータスを確認してください',
      '  - しばらく待ってから再試行してください',
    ].join('\n');
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return [
      'Claude API認証エラー（401 Unauthorized）',
      '  対処方法:',
      '  - .envファイルの CLAUDE_API_KEY を確認してください',
      '  - https://console.anthropic.com/ でAPIキーを確認・再発行してください',
    ].join('\n');
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return [
      'Claude APIアクセス拒否（403 Forbidden）',
      '  対処方法:',
      '  - APIキーに必要な権限があるか確認してください',
      '  - Batch APIを使用するにはBeta機能へのアクセスが必要な場合があります',
      '  - https://console.anthropic.com/ でAPIキーの設定を確認してください',
    ].join('\n');
  }
  if (e instanceof Anthropic.RateLimitError) {
    return [
      'Claude APIレート制限超過（429 Too Many Requests）',
      '  対処方法:',
      '  - しばらく待ってから再試行してください',
      '  - https://console.anthropic.com/ でAPI使用量を確認してください',
    ].join('\n');
  }
  if (e instanceof Anthropic.InternalServerError) {
    return [
      `Claude APIサーバーエラー（HTTP ${e.status}）`,
      '  Claude APIが一時的に停止またはエラー状態の可能性があります',
      '  対処方法:',
      '  - https://status.anthropic.com/ でAPIステータスを確認してください',
      '  - しばらく待ってから再試行してください',
    ].join('\n');
  }
  if (e instanceof Anthropic.APIStatusError) {
    return [
      `Claude APIエラー（HTTP ${e.status}）`,
      `  エラー内容: ${e.message}`,
      '  対処方法:',
      '  - https://status.anthropic.com/ でAPIステータスを確認してください',
    ].join('\n');
  }
  return e instanceof Error ? e.message : String(e);
}
