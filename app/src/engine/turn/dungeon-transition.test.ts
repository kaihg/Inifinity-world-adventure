import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { extractDungeonLog } from "../../engine/dungeon.js";
import { appendDungeonStartMarker, appendDungeonEndMarker, generateSecrets } from "./dungeon-transition.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "dungeon-test-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("extractDungeonLog", () => {
  it("extracts content between start and end markers", () => {
    const journal = [
      "主空間的冒險繼續中...",
      "<!-- dungeon-start: 命運樞紐-run-001 2026-06-29T10:00:00 -->",
      "副本第一回合敘事",
      "副本第二回合敘事",
      "<!-- dungeon-end: 命運樞紐-run-001 -->",
      "主空間又回來了",
    ].join("\n");
    const result = extractDungeonLog(journal, "命運樞紐-run-001");
    expect(result).toContain("副本第一回合敘事");
    expect(result).toContain("副本第二回合敘事");
    expect(result).not.toContain("主空間的冒險");
    expect(result).not.toContain("主空間又回來了");
  });

  it("returns empty string when run id not found", () => {
    const journal = "主空間內容\n主空間更多內容";
    expect(extractDungeonLog(journal, "不存在-run-001")).toBe("");
  });

  it("returns content to end of file when end marker is missing (dungeon still active)", () => {
    const journal = [
      "主空間的冒險",
      "<!-- dungeon-start: 試驗副本-run-1 2026-06-29T11:00:00 -->",
      "副本進行中",
    ].join("\n");
    const result = extractDungeonLog(journal, "試驗副本-run-1");
    expect(result).toBe("副本進行中");
  });
});

describe("appendDungeonStartMarker", () => {
  it("appends start marker to journal.md", async () => {
    await writeFile(path.join(tmpDir, "journal.md"), "初始內容\n", "utf8");
    await appendDungeonStartMarker(tmpDir, "測試副本-run-1", "2026-06-29T10:00:00");
    const content = await readFile(path.join(tmpDir, "journal.md"), "utf8");
    expect(content).toContain("<!-- dungeon-start: 測試副本-run-1 2026-06-29T10:00:00 -->");
    expect(content).toContain("初始內容");
  });
});

describe("appendDungeonEndMarker", () => {
  it("appends end marker to journal.md", async () => {
    await writeFile(path.join(tmpDir, "journal.md"), "初始內容\n", "utf8");
    await appendDungeonEndMarker(tmpDir, "測試副本-run-1");
    const content = await readFile(path.join(tmpDir, "journal.md"), "utf8");
    expect(content).toContain("<!-- dungeon-end: 測試副本-run-1 -->");
  });
});

describe("generateSecrets", () => {
  it("傳給 LLM 的系統 prompt 包含禁止跨副本元資訊的約束", async () => {
    let capturedMessages: ChatMessage[] = [];
    const mockClient: LlmClient = {
      async *streamChat(messages) {
        capturedMessages = messages;
        yield "測試隱藏真相內容";
      },
    };
    await generateSecrets(mockClient, "# 測試世界設定", "test-dungeon-001");
    const sysPrompt = capturedMessages.find((m) => m.role === "system")?.content ?? "";
    expect(sysPrompt).toContain("禁止在副本 secrets 引入跨副本的元資訊");
    expect(sysPrompt).toContain("主神");
  });

  it("傳給 LLM 的 user message 包含副本 id", async () => {
    let capturedMessages: ChatMessage[] = [];
    const mockClient: LlmClient = {
      async *streamChat(messages) {
        capturedMessages = messages;
        yield "隱藏真相";
      },
    };
    await generateSecrets(mockClient, "# 設定", "bio-hazard-raccoon-city");
    const userMsg = capturedMessages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("bio-hazard-raccoon-city");
  });

  it("LLM 回傳空字串時回傳降級預設值", async () => {
    const mockClient: LlmClient = {
      async *streamChat() { /* no yield */ },
    };
    const result = await generateSecrets(mockClient, "# 設定", "空回傳副本");
    expect(result).toBe("（生成失敗，待補）");
  });
});

describe("roundtrip: journal boundary markers + extractDungeonLog", () => {
  it("extracts dungeon entries from journal written with markers", async () => {
    const journalPath = path.join(tmpDir, "journal.md");
    await writeFile(journalPath, "# 主世界日誌\n\n主空間第一回合\n", "utf8");
    await appendDungeonStartMarker(tmpDir, "試煉空間-run-1", "2026-06-29T12:00:00");
    await appendFile(journalPath, "\n副本敘事一\n", "utf8");
    await appendFile(journalPath, "\n副本敘事二\n", "utf8");
    await appendDungeonEndMarker(tmpDir, "試煉空間-run-1");
    await appendFile(journalPath, "\n主空間回來了\n", "utf8");

    const content = await readFile(journalPath, "utf8");
    const extracted = extractDungeonLog(content, "試煉空間-run-1");

    expect(extracted).toContain("副本敘事一");
    expect(extracted).toContain("副本敘事二");
    expect(extracted).not.toContain("主空間第一回合");
    expect(extracted).not.toContain("主空間回來了");
  });
});
