import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../logger.js";
import { createSilentLogger } from "../../logger.js";
import { trackLoreSync, scheduleLoreSync } from "./lore-sync.js";
import type { PendingLoreSync, TurnDeps, TurnPlan } from "./types.js";

describe("trackLoreSync（永遠 resolve 語意）", () => {
  it("傳入會 reject 的 promise，包裝後 handle.promise 仍 resolve，並記一筆 warn", async () => {
    const warnCalls: unknown[] = [];
    const fakeLog = { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as Logger;
    const handle: PendingLoreSync = { promise: null };
    const rejecting = Promise.reject(new Error("Layer 3 任務本身炸了"));

    trackLoreSync(handle, rejecting, fakeLog);

    expect(handle.promise).not.toBeNull();
    await expect(handle.promise).resolves.toBeUndefined();
    expect(warnCalls).toHaveLength(1);
  });
});

describe("scheduleLoreSync", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "lore-sync-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does not throw when ingest returns empty extraction", async () => {
    const emptyJson = JSON.stringify({ protagonist_changed: false, entities: [] });
    const client = { streamChat: vi.fn(async function* () { yield emptyJson; }) } as unknown as any;
    await writeFile(path.join(tmpDir, "journal.md"), "無實體的敘事", "utf8");
    const deps = {
      client, loreClient: client, worldDir: tmpDir,
      commit: vi.fn(async () => false),
    } as unknown as TurnDeps;
    const plan = {} as TurnPlan;
    await expect(scheduleLoreSync(deps, "無實體的敘事", "", plan, createSilentLogger())).resolves.toBeUndefined();
  });
});
