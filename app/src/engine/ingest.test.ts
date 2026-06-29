import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LlmClient } from "../llm/client.js";
import { extractEntities, runIngest } from "./ingest.js";
import type { TurnDeps } from "./turn/types.js";
import { createSilentLogger } from "../logger.js";

function makeMockClient(response: string): LlmClient {
  return {
    streamChat: vi.fn(async function* () { yield response; }),
  } as unknown as LlmClient;
}

const log = createSilentLogger();

describe("extractEntities", () => {
  it("parses protagonist_changed and entities from LLM JSON", async () => {
    const json = JSON.stringify({
      protagonist_changed: true,
      entities: [
        { id: "邏輯推理", category: "skill", name: "邏輯推理（中級）" },
      ],
    });
    const client = makeMockClient(json);
    const result = await extractEntities(client, "敘事內容", "", {}, log);
    expect(result.protagonist_changed).toBe(true);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("邏輯推理");
  });

  it("returns empty result on parse failure", async () => {
    const client = makeMockClient("不是 JSON");
    const result = await extractEntities(client, "敘事內容", "", {}, log);
    expect(result.protagonist_changed).toBe(false);
    expect(result.entities).toHaveLength(0);
  });
});

describe("runIngest", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ingest-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes entity file when entity extracted", async () => {
    // extraction → 抽到技能「邏輯推理」
    const extractionJson = JSON.stringify({
      protagonist_changed: false,
      entities: [{ id: "邏輯推理", category: "skill", name: "邏輯推理" }],
    });
    // entity rewrite → 回傳技能描述
    const entityRewriteText = "# 邏輯推理\n\n## 初級\n基礎邏輯訓練。";
    // wiki rewrite
    const wikiRewriteText = "# 技能索引\n\n## 主動技能\n- [[邏輯推理]]";

    let callCount = 0;
    const client = {
      streamChat: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) yield extractionJson;        // Step 1
        else if (callCount === 2) yield entityRewriteText; // Step 2 entity
        else yield wikiRewriteText;                        // Step 3 wiki
      }),
    } as unknown as LlmClient;

    // 寫入 journal.md（cursor 從 0 開始讀全部）
    await writeFile(path.join(tmpDir, "journal.md"), "本回合敘事：主角使用了邏輯推理技能。", "utf8");
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });

    const deps = {
      client,
      loreClient: client,
      worldDir: tmpDir,
      commit: vi.fn(async () => true),
    } as unknown as TurnDeps;

    await runIngest(deps, "本回合敘事：主角使用了邏輯推理技能。", "", log);

    const entityFile = await readFile(path.join(tmpDir, "skills", "邏輯推理.md"), "utf8");
    expect(entityFile).toContain("邏輯推理");
    const wikiFile = await readFile(path.join(tmpDir, "skills", "wiki.md"), "utf8");
    expect(wikiFile).toContain("[[邏輯推理]]");
  });
});
