import type { MemoryType } from "../types.js";

const tagRules: [string, RegExp][] = [
  ["language", /\b(python|javascript|typescript|java|rust|golang|c\+\+)\b/i],
  ["communication", /\b(answer|response|concise|detail|explain|email)\b/i],
  ["work", /\b(project|work|job|meeting|deadline|team)\b/i],
  ["food", /\b(food|allerg|vegetarian|vegan|coffee|eat)/i],
  ["location", /\b(live in|based in|moved to|timezone|time zone)\b/i],
];

export function extractTags(content: string): string[] {
  return tagRules.filter(([, pattern]) => pattern.test(content)).map(([tag]) => tag);
}

export function scoreImportance(content: string, type: MemoryType): number {
  const base = { fact: 0.5, preference: 0.65, episode: 0.35, summary: 0.7 }[type];
  return Math.min(
    1,
    base + (/\b(always|never|important|allerg|must|remember)\b/i.test(content) ? 0.2 : 0),
  );
}
