import { readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";

const CURSOR_FILE = ".ingest-cursor";

/** 讀取 ingest cursor（journal.md byte offset）；檔案不存在回 0 */
export async function readCursor(worldDir: string): Promise<number> {
  try {
    const content = await readFile(path.join(worldDir, CURSOR_FILE), "utf8");
    const n = parseInt(content.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** 寫入 ingest cursor */
export async function writeCursor(worldDir: string, offset: number): Promise<void> {
  await writeFile(path.join(worldDir, CURSOR_FILE), String(offset), "utf8");
}

/** 讀取 journal.md 從 byteOffset 到結尾（UTF-8 byte offset） */
export async function readJournalDelta(worldDir: string, fromOffset: number): Promise<string> {
  const journalPath = path.join(worldDir, "journal.md");
  try {
    const fh = await open(journalPath, "r");
    try {
      const stat = await fh.stat();
      const size = stat.size;
      if (fromOffset >= size) return "";
      const buf = Buffer.allocUnsafe(size - fromOffset);
      await fh.read(buf, 0, buf.length, fromOffset);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}
