import * as OpenCC from "opencc-js";

/**
 * 簡體 → 台灣正體（含台灣慣用詞）轉換器。
 * `to: "twp"`（s2twp）除了字形，還做台灣慣用詞轉換（信息→資訊、視頻→影片、軟件→軟體、
 * 內存→記憶體、鼠標→滑鼠…），這些 OpenCC 詞庫已涵蓋，不需自己維護。
 */
const converter = OpenCC.Converter({ from: "cn", to: "twp" });

/**
 * 補 OpenCC twp 仍漏的「字形已轉、但台灣慣用寫法不同」詞。
 * 經實測 twp 已涵蓋絕大多數陸詞，這裡只放確認漏網的：
 * - 「賬」OpenCC 轉成「賬」（賬號/賬戶/記賬），台灣慣用「帳」。
 * 注意：不放「質量→品質」——「質量」在物理語境（物體質量）是合法正體詞，
 * 小說敘事誤傷風險高於收益，交由 prompt 規範（TRADITIONAL_CHINESE_RULE）處理。
 * 補充項以「字」為單位用全域替換，能一次涵蓋所有含該字的詞。
 */
const SUPPLEMENT: ReadonlyArray<readonly [RegExp, string]> = [[/賬/g, "帳"]];

/**
 * 把任意文字轉成台灣正體中文。對純正體輸入冪等（不破壞既有繁體內容），
 * 對英文/slug/數字無副作用。引擎在「落地進 world/ 前」對 LLM 動態產出呼叫，
 * 從源頭杜絕簡體寫進 canonical 檔後又被當輸入餵回模型的雪球效應。
 */
export function toTraditional(text: string): string {
  if (!text) return text;
  let out = converter(text);
  for (const [re, to] of SUPPLEMENT) out = out.replace(re, to);
  return out;
}
