import { randomInt } from "node:crypto";

/** 一顆密碼學等級的 d100（1..100），不可被 LLM 預測或竄改 */
export function cryptoD100(): number {
  return randomInt(1, 101);
}

/**
 * 預擲一組骰值供本回合使用。引擎先擲、寫進 log，再交給敘事——
 * 落實「真隨機、先擲骰再敘事」，杜絕 LLM 自行捏造機率結果。
 */
export function rollPool(n: number, next: () => number = cryptoD100): number[] {
  return Array.from({ length: n }, () => next());
}
