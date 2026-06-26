import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { logger as defaultLogger, type Logger } from "../logger.js";

export interface CommitWorldOptions {
  repoRoot: string;
  message: string;
  authorName: string;
  authorEmail: string;
  logger?: Logger;
}

/**
 * 把 world/（與 meta/，若存在）的變更 commit 到當前分支（每回合自動 commit）。
 * 無變更時不產生空 commit，回傳 false。
 * git 操作失敗會記錄完整錯誤後原樣往上拋，讓呼叫端既有的錯誤處理不變。
 */
export async function commitWorld(opts: CommitWorldOptions): Promise<boolean> {
  const log = opts.logger ?? defaultLogger;
  const git = simpleGit(opts.repoRoot);
  try {
    const pathspecs = ["world"];
    if (existsSync(path.join(opts.repoRoot, "meta"))) {
      pathspecs.push("meta");
    }
    await git.add(pathspecs);

    const status = await git.status();
    if (status.staged.length === 0) {
      log.debug({ repoRoot: opts.repoRoot }, "world/ 無變更，跳過 commit");
      return false;
    }

    await git.commit(opts.message, undefined, {
      "--author": `${opts.authorName} <${opts.authorEmail}>`,
    });
    log.info(
      { message: opts.message, files: status.staged },
      "已自動 commit world/",
    );
    return true;
  } catch (err) {
    log.error({ err, repoRoot: opts.repoRoot, message: opts.message }, "git commit 失敗");
    throw err;
  }
}
