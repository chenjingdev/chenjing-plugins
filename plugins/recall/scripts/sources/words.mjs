export const wordPattern = (word) => {
  const left = /^[a-z0-9]/.test(word) ? '(?<![a-z0-9])' : '';
  const right = /[a-z0-9]$/.test(word) ? '(?![a-z0-9])' : '';
  return new RegExp(left + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + right);
};

// 백틱 안의 코드 조각은 낱말로 치지 않는다: 함수·경로 이름이 주제와 우연히 겹쳐 상관없는 기록이 걸리는 것을 막는다
export function overlapOf(topicWords, text) {
  const haystack = String(text).replace(/`[^`]*`/g, ' ').toLowerCase();
  const words = [...new Set(topicWords.map((w) => w.toLowerCase()))];
  return words.filter((w) => wordPattern(w).test(haystack)).length;
}
