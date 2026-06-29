import { describe, it, expect, vi } from "vitest";
import type { LlmClient } from "../llm/client.js";
import { extractEntities } from "./ingest.js";
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
