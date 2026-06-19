import { simpleGit } from "simple-git";

export interface CommitWorldOptions {
  repoRoot: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

/**
 * 把 world/ 的變更 commit 到當前分支（每回合自動 commit）。
 * 無變更時不產生空 commit，回傳 false。
 */
export async function commitWorld(opts: CommitWorldOptions): Promise<boolean> {
  const git = simpleGit(opts.repoRoot);
  await git.add(["world"]);

  const status = await git.status();
  if (status.staged.length === 0) return false;

  await git.commit(opts.message, undefined, {
    "--author": `${opts.authorName} <${opts.authorEmail}>`,
  });
  return true;
}
