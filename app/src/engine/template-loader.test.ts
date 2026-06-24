// app/src/engine/template-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTemplate } from "./template-loader.js";

describe("getTemplate", () => {
  let tmpRoot: string;
  let worldDir: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "iwa-tpl-"));
    repoRoot = tmpRoot;
    worldDir = path.join(tmpRoot, "world");
    await mkdir(path.join(worldDir, "templates"), { recursive: true });
    await mkdir(path.join(tmpRoot, "templates"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("world/templates/<type>.md 存在時回傳世界特定骨架", async () => {
    await writeFile(
      path.join(worldDir, "templates", "item.md"),
      "# 世界特定 item 骨架",
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "templates", "item.md"),
      "# 全域 item 骨架",
      "utf8",
    );
    const result = await getTemplate("item", worldDir, repoRoot);
    expect(result).toBe("# 世界特定 item 骨架");
  });

  it("world/templates/<type>.md 不存在時退回全域 templates/", async () => {
    await writeFile(
      path.join(tmpRoot, "templates", "npc.md"),
      "# 全域 npc 骨架",
      "utf8",
    );
    const result = await getTemplate("npc", worldDir, repoRoot);
    expect(result).toBe("# 全域 npc 骨架");
  });

  it("兩份都不存在時拋出 Error", async () => {
    await expect(getTemplate("nonexistent", worldDir, repoRoot)).rejects.toThrow(
      "找不到 nonexistent 的 template",
    );
  });
});
