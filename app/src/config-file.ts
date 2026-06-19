import { readFile, writeFile } from "node:fs/promises";

/** 在既有 .env 內容上更新/新增鍵值，保留其餘行（含註解） */
export function applyEnvUpdates(existing: string, updates: Record<string, string>): string {
  const keys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const lines = existing.split("\n");

  const out = lines.map((line) => {
    const m = line.match(/^(\w+)=/);
    if (m && keys.has(m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  const appended: string[] = [];
  for (const k of keys) {
    if (!seen.has(k)) appended.push(`${k}=${updates[k]}`);
  }
  if (appended.length === 0) return out.join("\n");

  // 收掉結尾多餘空行後再附加
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return [...out, ...appended, ""].join("\n");
}

/** 把更新寫回 .env（檔案不存在則新建） */
export async function writeEnvUpdates(
  envPath: string,
  updates: Record<string, string>,
): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch {
    existing = "";
  }
  await writeFile(envPath, applyEnvUpdates(existing, updates), "utf8");
}
