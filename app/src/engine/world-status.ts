import { readFile } from "node:fs/promises";
import path from "node:path";

/** world/setting.md 尚未初始化時的固定佔位內容（機器可判斷的 marker） */
export const UNINITIALIZED_SETTING_PLACEHOLDER = `# 世界設定（World Setting）

> 尚未初始化。請透過世界初始化精靈建立新世界。
`;

/** world/gm-notes.md 尚未初始化時的固定佔位內容 */
export const UNINITIALIZED_GM_NOTES_PLACEHOLDER = `# 世界隱藏真相（GM Notes）

> 尚未生成。
`;

/**
 * 判斷世界是否已初始化：setting.md 不存在，或內容（trim 後）等於佔位文字，都視為未初始化。
 * 只比對 setting.md，不檢查其他檔案——setting.md 是這個判斷的唯一真相來源。
 */
export async function isWorldInitialized(worldDir: string): Promise<boolean> {
  let settingMd: string;
  try {
    settingMd = await readFile(path.join(worldDir, "setting.md"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
  return settingMd.trim() !== UNINITIALIZED_SETTING_PLACEHOLDER.trim();
}
