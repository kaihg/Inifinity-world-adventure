import { describe, it, expect } from "vitest";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { logger } from "../../logger.js";
import type { Logger } from "../../logger.js";
import { callLoreRewrite, type LoreRewriteCategory, generateEntitySecrets, rewriteLoreEntity } from "./lore-rewrite.js";
import { mkdtemp, mkdir } from "node:fs/promises";
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
  };
  return result;
}

function throwingClient(): LlmClient {
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
      throw new Error("LLM 呼叫失敗");
    },
  };
}

function fakeLogger(): { log: Logger; warnCalls: unknown[] } {
  const warnCalls: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as Logger;
  return { log, warnCalls };
}

describe("callLoreRewrite", () => {
  it("system prompt 含繁體用詞規範", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger);
    const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("避免中國大陸簡體中文慣用詞彙");
  });

  it.each([
    ["item", "外觀與基本辨識"],
    ["location", "已知規則或機關"],
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
});

describe("generateEntitySecrets", () => {
  it.each([
    ["item", "道具設計者", "道具名稱"],
    ["location", "場景設計者", "場景名稱"],
    ["skill", "技能設計者", "技能名稱"],
  ] as [("item" | "location" | "skill"), string, string][])(
    "category=%s 時措辭正確（%s / %s）",
    async (category, roleKeyword, nounKeyword) => {
      const cap = capturingClient("隱藏設定內容");
      await generateEntitySecrets(cap.client, "世界設定", "測試實體", category, logger);
      const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
      const user = cap.messages.find((m) => m.role === "user")?.content ?? "";
      expect(system).toContain(roleKeyword);
      expect(user).toContain(nounKeyword);
    },
  );

  it("client.streamChat 拋錯時回退預設文字並記一筆 warn，不往上拋", async () => {
    const { log, warnCalls } = fakeLogger();

    const result = await generateEntitySecrets(throwingClient(), "世界設定", "神祕道具", "item", log);

    expect(result).toBe("（生成失敗，待補）");
    expect(warnCalls).toHaveLength(1);
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

describe("rewriteLoreEntity — secrets 用小模型（根因 G）", () => {
  it("生成 secrets 用 loreClient 而非主敘事 client", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "items", "amulet-001"), { recursive: true });

    const mainCalls: string[] = [];
    const loreCalls: string[] = [];
    const mainClient: LlmClient = {
      async *streamChat() {
        mainCalls.push("main");
        yield "主模型不該被叫到";
      },
    };
    const loreClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        loreCalls.push("lore");
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        yield system.includes("劇透文件") ? "隱藏真相" : "# 護符\n\n外觀";
      },
    };
    const deps: TurnDeps = { client: mainClient, loreClient, worldDir, commit: async () => true };

    await rewriteLoreEntity(
      deps,
      "世界設定",
      { id: "amulet-001", category: "item", name: "護符", excerpt: "主角撿到一個護符" },
      logger,
    );

    expect(mainCalls).toHaveLength(0); // 主敘事大模型完全不參與 lore 落地
    expect(loreCalls.length).toBeGreaterThanOrEqual(2); // secrets + wiki 都走小模型
  });
});
