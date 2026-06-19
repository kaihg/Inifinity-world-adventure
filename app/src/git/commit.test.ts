import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { commitWorld } from "./commit.js";

let repo: string;
const author = { authorName: "Test Engine", authorEmail: "t@e.com" };

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "iwa-git-"));
  const git = simpleGit(repo);
  await git.init();
  await git.addConfig("user.name", "init");
  await git.addConfig("user.email", "init@x.com");
  await mkdir(path.join(repo, "world"), { recursive: true });
  await writeFile(path.join(repo, "world", "now.md"), "init\n");
  await git.add(".").commit("init");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("commitWorld", () => {
  it("有變更時 commit world/，回 true，log 出現訊息", async () => {
    await writeFile(path.join(repo, "world", "now.md"), "changed\n");
    const ok = await commitWorld({ repoRoot: repo, message: "回合摘要", ...author });
    expect(ok).toBe(true);
    const log = await simpleGit(repo).log();
    expect(log.latest?.message).toBe("回合摘要");
    expect(log.latest?.author_name).toBe("Test Engine");
  });

  it("無變更時回 false，不產生空 commit", async () => {
    const ok = await commitWorld({ repoRoot: repo, message: "無事", ...author });
    expect(ok).toBe(false);
    const log = await simpleGit(repo).log();
    expect(log.total).toBe(1);
  });
});
