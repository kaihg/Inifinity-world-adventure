export const STATE_SENTINEL = "===STATE===";

/**
 * 串流切分器：模型先輸出敘事散文，再以 `===STATE===` 分隔，最後輸出 JSON 控制區塊。
 * push() 逐段餵入 delta，回傳「可安全轉發給前端的敘事文字」；
 * 一旦偵測到 sentinel，之後不再轉發（控制區塊只進 full()，不顯示給玩家）。
 */
export function createNarrativeSplitter(marker: string = STATE_SENTINEL) {
  let acc = "";
  let forwarded = 0;
  let sentinelSeen = false;

  return {
    push(delta: string): string {
      acc += delta;
      if (sentinelSeen) return "";

      const idx = acc.indexOf(marker);
      if (idx !== -1) {
        sentinelSeen = true;
        const out = acc.slice(forwarded, idx);
        forwarded = idx;
        return out;
      }
      // 保留尾端 marker.length-1 個字，避免 sentinel 被切在 chunk 邊界時提前外漏
      const safe = Math.max(forwarded, acc.length - (marker.length - 1));
      const out = acc.slice(forwarded, safe);
      forwarded = safe;
      return out;
    },
    /** 串流結束時呼叫：沒看到 sentinel 的情況下，吐出尚未轉發的尾段 */
    flush(): string {
      if (sentinelSeen) return "";
      const out = acc.slice(forwarded);
      forwarded = acc.length;
      return out;
    },
    full(): string {
      return acc;
    },
    sawSentinel(): boolean {
      return sentinelSeen;
    },
  };
}
