import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { logger } from "../../logger.js";
import type { Logger } from "../../logger.js";
import { callLoreRewrite, type LoreRewriteCategory, rewriteLoreEntity } from "./lore-rewrite.js";
import { loreFilePath, loadLoreFile, rewriteLoreFile, listLoreIds } from "../../engine/lore.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { TurnDeps } from "./types.js";

function capturingClient(response: string): { client: LlmClient; messages: ChatMessage[] } {
  const result = { messages: [] as ChatMessage[] } as { client: LlmClient; messages: ChatMessage[] };
  result.client = {
    async *streamChat(messages: ChatMessage[]) {
      result.messages = messages;
      yield response;
    },
    async chat(messages: ChatMessage[]) {
      result.messages = messages;
      return response;
    },
  };
  return result;
}

function throwingClient(): LlmClient {
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
      throw new Error("LLM 呼叫失敗");
    },
    async chat(_messages: ChatMessage[]): Promise<string> {
      throw new Error("LLM 呼叫失敗");
    },
  };
}

function fakeLogger(): { log: Logger; warnCalls: unknown[] } {
  const warnCalls: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as Logger;
  return { log, warnCalls };
}

describe("lore flat API", () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "lore-test-")); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("loreFilePath returns world/<category>/<id>.md", () => {
    expect(loreFilePath(tmpDir, "skills", "邏輯推理")).toBe(
      path.join(tmpDir, "skills", "邏輯推理.md")
    );
  });

  it("loadLoreFile returns empty string when file missing", async () => {
    const result = await loadLoreFile(tmpDir, "skills", "不存在");
    expect(result).toBe("");
  });

  it("loadLoreFile returns content when file exists", async () => {
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });
    await writeFile(path.join(tmpDir, "skills", "邏輯推理.md"), "# 邏輯推理\n\n內容", "utf8");
    const result = await loadLoreFile(tmpDir, "skills", "邏輯推理");
    expect(result).toBe("# 邏輯推理\n\n內容");
  });

  it("rewriteLoreFile creates file with H1 when title missing", async () => {
    await rewriteLoreFile(tmpDir, "skills", "邏輯推理", "內容段落", "邏輯推理");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path.join(tmpDir, "skills", "邏輯推理.md"), "utf8");
    expect(content).toContain("# 邏輯推理");
    expect(content).toContain("內容段落");
  });

  it("listLoreIds returns .md filenames without extension", async () => {
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });
    await writeFile(path.join(tmpDir, "skills", "技能A.md"), "", "utf8");
    await writeFile(path.join(tmpDir, "skills", "技能B.md"), "", "utf8");
    const ids = await listLoreIds(tmpDir, "skills");
    expect(ids.sort()).toEqual(["技能A", "技能B"]);
  });
});

describe("callLoreRewrite", () => {
  it("system prompt 含繁體用詞規範", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger);
    const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("避免中國大陸簡體中文慣用詞彙");
  });

  it.each([
    ["item", "外觀與基本辨識"],
    ["scene", "已知規則或機關"],
    ["skill", "施展條件/限制"],
    ["npc", "與主角的關係"],
    ["dungeon", "已揭露地圖/環境"],
  ] as [LoreRewriteCategory, string][])(
    "category=%s 時 system prompt 含對應大綱關鍵字 %s",
    async (category, keyword) => {
      const cap = capturingClient("新版內容");
      await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", category, logger);
      const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain(keyword);
    },
  );

  it("client.streamChat 拋錯時回 null 並記一筆 warn，不往上拋", async () => {
    const { log, warnCalls } = fakeLogger();

    const result = await callLoreRewrite(throwingClient(), "世界設定", "片段", "文件標題", "", "item", log);

    expect(result).toBeNull();
    expect(warnCalls).toHaveLength(1);
  });

  it("全新建檔且有 scaffoldContent 時，system prompt 含骨架內容", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(
      cap.client, "世界設定", "片段", "標題", "",
      "item", logger, undefined, "## 品質等級\n<!-- 填入 -->\n## 效果/說明\n<!-- 填入 -->",
    );
    const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("## 品質等級");
    expect(system).toContain("文件骨架（段落標題固定");
  });

  it("existingContent 非空時不注入骨架，即使有 scaffoldContent", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(
      cap.client, "世界設定", "片段", "標題", "# 現有內容\n\n已有文件",
      "item", logger, undefined, "## 品質等級\n<!-- 填入 -->",
    );
    const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).not.toContain("文件骨架（段落標題固定");
  });
});

describe("rewriteLoreEntity 標題", () => {
  it("道具 wiki 標題用 entity.name 而非 entity.id", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "items", "sword-001"), { recursive: true });

    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
        yield systemContent.includes("劇透文件") ? "隱藏設定內容" : "# 淬毒匕首\n\n外觀描述";
      },
      async chat(messages: ChatMessage[]): Promise<string> {
        const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
        return systemContent.includes("劇透文件") ? "隱藏設定內容" : "# 淬毒匕首\n\n外觀描述";
      },
    };
    const deps: TurnDeps = {
      client: fakeClient,
      worldDir,
      commit: async () => true,
    };

    const result = await rewriteLoreEntity(
      deps,
      "世界設定",
      { id: "sword-001", category: "item", name: "淬毒匕首", excerpt: "主角拿到一把淬毒匕首" },
      logger,
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("道具（淬毒匕首）");
  });
});

describe("callLoreRewrite — 繁體化與情境（根因 B/C/F）", () => {
  it("回傳內容繁體化（簡體輸出被轉成正體）", async () => {
    const cap = capturingClient("叶晴确认了触发机制");
    const result = await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger);
    expect(result).toBe("葉晴確認了觸發機制");
  });

  it("全新建檔 prompt 禁止擴寫敘事未提供的細節（根因 B）", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger);
    const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("不可發明、不可擴寫敘事未提供的任何細節");
    expect(system).not.toContain("可以在風格/氛圍類細節上做簡單合理的擴寫");
  });

  it("帶 context 時 user content 標明主角在副本內（根因 F）", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger, {
      inDungeon: true,
      dungeonId: "u-001",
    });
    const user = cap.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("在副本「u-001」內");
  });

  it("帶 context 時 user content 標明主角在安全區（根因 F）", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger, { inDungeon: false });
    const user = cap.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("安全區（非副本）");
  });
});

describe("rewriteLoreEntity — NPC 角色檔標題正規化（根因 I）", () => {
  it("模型用 ### 起頭時補上 H1 角色名，內容不以 ### 開頭", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    const fakeClient: LlmClient = {
      async *streamChat() {
        yield "### 基本資訊\n\n葉晴是前特種部隊教官。";
      },
      async chat(): Promise<string> {
        return "### 基本資訊\n\n葉晴是前特種部隊教官。";
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true };
    const result = await rewriteLoreEntity(
      deps,
      "世界設定",
      { id: "yeqing", category: "npc", name: "葉晴", excerpt: "葉晴登場" },
      logger,
    );
    expect(result).not.toBeNull();
    expect(result!.content.startsWith("# 葉晴")).toBe(true);
    expect(result!.content.startsWith("###")).toBe(false);
    expect(result!.title).toBe("葉晴");
  });

  it("模型已用 H1（# 姓名）起頭時保留原標題，不重複補", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    const fakeClient: LlmClient = {
      async *streamChat() {
        yield "# 陳哲\n\n老手，拒絕入隊。";
      },
      async chat(): Promise<string> {
        return "# 陳哲\n\n老手，拒絕入隊。";
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true };
    const result = await rewriteLoreEntity(
      deps,
      "世界設定",
      { id: "chenzhe", category: "npc", name: "陳哲", excerpt: "陳哲登場" },
      logger,
    );
    // 已自帶 H1，內容原樣保留、不重複補標題
    expect(result!.content).toBe("# 陳哲\n\n老手，拒絕入隊。");
    expect(result!.title).toBe("陳哲");
  });

  it("### 開頭但後面某行有 # x 時，仍補開頭 H1（C3：只認開頭 H1，不被任意行的 # 騙過）", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    const fakeClient: LlmClient = {
      async *streamChat() {
        // 首行是 ###，但內文某行出現一個 H1（例如引用、標籤），不可被當成「已自帶標題」
        yield "### 基本資訊\n\n葉晴是教官。\n\n# 補充\n\n備註。";
      },
      async chat(): Promise<string> {
        return "### 基本資訊\n\n葉晴是教官。\n\n# 補充\n\n備註。";
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true };
    const result = await rewriteLoreEntity(
      deps,
      "世界設定",
      { id: "yeqing", category: "npc", name: "葉晴", excerpt: "葉晴登場" },
      logger,
    );
    expect(result!.content.startsWith("# 葉晴")).toBe(true);
    expect(result!.content.startsWith("###")).toBe(false);
    expect(result!.title).toBe("葉晴");
  });
});

describe("rewriteLoreEntity — 骨架注入（全新建檔）", () => {
  it("全新建檔時 system prompt 含骨架內容（來自 getTemplate）", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    // 建全域骨架
    const repoRoot = path.dirname(worldDir);
    await mkdir(path.join(repoRoot, "templates"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "templates", "item.md"),
      "# 道具：{{道具名稱}}\n\n## 品質等級\n<!-- 填入 -->\n## 效果/說明\n<!-- 填入 -->",
      "utf8",
    );
    await mkdir(path.join(worldDir, "items", "iron-sword"), { recursive: true });

    const messages: ChatMessage[] = [];
    const capClient: LlmClient = {
      async *streamChat(msgs: ChatMessage[]) {
        messages.push(...msgs);
        yield msgs.find((m) => m.role === "system")?.content?.includes("劇透文件")
          ? "隱藏設定"
          : "## 品質等級\n普通\n## 效果/說明\n造成傷害";
      },
      async chat(msgs: ChatMessage[]): Promise<string> {
        messages.push(...msgs);
        return msgs.find((m) => m.role === "system")?.content?.includes("劇透文件")
          ? "隱藏設定"
          : "## 品質等級\n普通\n## 效果/說明\n造成傷害";
      },
    };
    const deps: TurnDeps = { client: capClient, worldDir, commit: async () => true };

    await rewriteLoreEntity(
      deps, "世界設定",
      { id: "iron-sword", category: "item", name: "鐵劍", excerpt: "主角撿到一把鐵劍" },
      logger,
    );

    const systemMsg = messages.find((m) => m.role === "system" && !m.content.includes("劇透文件"))?.content ?? "";
    expect(systemMsg).toContain("文件骨架（段落標題固定");
    expect(systemMsg).toContain("## 品質等級");

    // cleanup
    await rm(worldDir, { recursive: true, force: true });
    await rm(path.join(repoRoot, "templates"), { recursive: true, force: true });
  });
});

import { callProtagonistRewrite } from "./lore-rewrite.js";

describe("callProtagonistRewrite", () => {
  function fakeClient(captured: { system: string[]; user: string[] }, out: string): LlmClient {
    return {
      async *streamChat(messages: ChatMessage[]) {
        captured.system.push(messages.find((m) => m.role === "system")?.content ?? "");
        captured.user.push(messages.find((m) => m.role === "user")?.content ?? "");
        yield out;
      },
      async chat(messages: ChatMessage[]): Promise<string> {
        captured.system.push(messages.find((m) => m.role === "system")?.content ?? "");
        captured.user.push(messages.find((m) => m.role === "user")?.content ?? "");
        return out;
      },
    };
  }

  it("把現有 protagonist 全文 + 敘事片段送進去，回傳整檔新版（繁體化）", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    const existing = "# 主角檔案\n- 姓名：沈奕\n- 當前積分：3\n\n## 物品欄\n- 戰術刀\n";
    const out = await callProtagonistRewrite(
      fakeClient(captured, "# 主角檔案\n- 姓名：沈奕\n- 當前積分：3\n\n## 物品欄\n- 戰術刀\n- 生鏽鐵管\n"),
      "世界設定",
      "沈奕從地上撿起一根生鏽鐵管。",
      existing,
      logger,
    );
    expect(out).toContain("生鏽鐵管");
    expect(captured.user[0]).toContain("沈奕從地上撿起一根生鏽鐵管"); // 敘事片段有送進去
    expect(captured.user[0]).toContain("當前積分：3"); // 現有全文有送進去
  });

  it("system prompt 含「積分區塊照抄不可改動」與「禁止照搬敘事散文」鐵則", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    await callProtagonistRewrite(fakeClient(captured, "x"), "設定", "片段", "# 主角\n- 當前積分：0\n", logger);
    expect(captured.system[0]).toContain("積分");
    expect(captured.system[0]).toContain("照抄");
    expect(captured.system[0]).toContain("禁止");
  });

  it("簡體輸出會被繁體化（決定論兜底）", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    const out = await callProtagonistRewrite(fakeClient(captured, "# 主角\n- 获得资讯\n"), "設定", "片段", "# 主角\n", logger);
    expect(out).toContain("資訊");
    expect(out).not.toContain("资讯");
  });

  it("LLM 回空白時回 null", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    const out = await callProtagonistRewrite(fakeClient(captured, "   "), "設定", "片段", "# 主角\n", logger);
    expect(out).toBeNull();
  });
});

describe("callLoreRewrite 禁止照搬敘事散文", () => {
  it("system prompt 含「禁止照搬敘事/系統提示」鐵則", async () => {
    const captured: string[] = [];
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        captured.push(messages.find((m) => m.role === "system")?.content ?? "");
        yield "# 道具（鐵管）\n";
      },
      async chat(messages: ChatMessage[]): Promise<string> {
        captured.push(messages.find((m) => m.role === "system")?.content ?? "");
        return "# 道具（鐵管）\n";
      },
    };
    await callLoreRewrite(client, "設定", "片段", "道具（鐵管）", "", "item", logger);
    expect(captured[0]).toContain("禁止");
    expect(captured[0]).toMatch(/照搬|轉貼|系統提示/);
  });
});
