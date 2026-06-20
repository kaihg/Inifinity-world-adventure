import { simpleGit } from "simple-git";

export interface AppVersionInfo {
  hash: string;
  message: string;
}

/**
 * 開發者用：app/ 目錄最後一次 commit 的短 hash + commit message。
 * 故事劇情走 world/ 的逐回合 commit，不會動到這裡，所以只看 app/ 能準確反映功能版本。
 */
export async function getAppVersion(repoRoot: string): Promise<AppVersionInfo | null> {
  try {
    const git = simpleGit(repoRoot);
    const raw = await git.raw(["log", "-1", "--format=%h%x09%s", "--", "app"]);
    const line = raw.trim();
    if (!line) return null;
    const [hash, message] = line.split("\t");
    return { hash, message: message ?? "" };
  } catch {
    // 測試環境的假 repoRoot 或非 git 目錄：版本顯示是開發輔助功能，失敗就降級為 null
    return null;
  }
}
