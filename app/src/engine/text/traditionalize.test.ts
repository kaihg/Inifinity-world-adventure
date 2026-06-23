import { describe, it, expect } from "vitest";
import { toTraditional } from "./traditionalize.js";

describe("toTraditional", () => {
  it("簡體字形轉繁體", () => {
    expect(toTraditional("叶晴确认触发信号")).toBe("葉晴確認觸發訊號");
    expect(toTraditional("开来")).toBe("開來");
  });

  it("台灣慣用詞（OpenCC twp 內建）正確轉換", () => {
    // 這些是 OpenCC twp profile 本身就會處理的詞，驗證我們確實用了 twp 而非 tw
    expect(toTraditional("信息")).toBe("資訊");
    expect(toTraditional("视频")).toBe("影片");
    expect(toTraditional("软件")).toBe("軟體");
    expect(toTraditional("鼠标")).toBe("滑鼠");
    expect(toTraditional("内存")).toBe("記憶體");
  });

  it("補充詞表補上 OpenCC 漏轉的詞", () => {
    // OpenCC twp 保留「賬號」的「賬」、不轉「質量」（物理語境合法），由補充表處理
    expect(toTraditional("账号")).toBe("帳號");
  });

  it("純繁體輸入維持等冪（不破壞既有繁體內容）", () => {
    const text = "葉晴確認警報裝置的觸發機制與訊號傳輸路線。";
    expect(toTraditional(text)).toBe(text);
  });

  it("英文與 slug 不被破壞", () => {
    expect(toTraditional("collision_alarm_device")).toBe("collision_alarm_device");
    expect(toTraditional("U-001 run-1")).toBe("U-001 run-1");
  });

  it("空字串原樣返回", () => {
    expect(toTraditional("")).toBe("");
  });

  it("多次套用結果穩定（冪等）", () => {
    const once = toTraditional("叶晴在安全区分析信息");
    expect(toTraditional(once)).toBe(once);
  });
});
