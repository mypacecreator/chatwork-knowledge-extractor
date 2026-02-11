import type { AnalyzedMessage } from '../claude/analyzer.js';

/**
 * 発言者名を匿名化したコピーを返す（元データは変更しない）
 */
export function anonymizeSpeakers(messages: AnalyzedMessage[]): AnalyzedMessage[] {
  const speakerMap = new Map<string, string>();
  let count = 0;

  return messages.map(item => {
    if (!speakerMap.has(item.speaker)) {
      count++;
      speakerMap.set(item.speaker, `発言者${count}`);
    }
    return { ...item, speaker: speakerMap.get(item.speaker)! };
  });
}
