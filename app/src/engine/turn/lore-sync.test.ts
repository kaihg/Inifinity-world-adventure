import { describe, it, expect } from "vitest";
import type { Logger } from "../../logger.js";
import { trackLoreSync } from "./lore-sync.js";
import type { PendingLoreSync } from "./types.js";

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
