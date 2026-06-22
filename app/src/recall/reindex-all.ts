import { createRecallIndex } from "./index.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function main() {
  const worldDir = path.resolve("../world");
  const indexDir = path.resolve(".recall-index");
  console.log("Initializing Recall Index in:", indexDir);
  const recall = createRecallIndex(indexDir);

  // 遞迴讀取 worldDir 底下的所有檔案
  const allEntries = await readdir(worldDir, { recursive: true, withFileTypes: true });

  // 篩選出所有以 .md 結尾的檔案路徑，並計算相對於 worldDir 的相對路徑
  const files = allEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const dirPath = entry.parentPath || (entry as any).path;
      const absPath = path.join(dirPath, entry.name);
      return path.relative(worldDir, absPath);
    });

  console.log(`Found ${files.length} markdown files in world/ to index.`);

  for (const f of files) {
    const absPath = path.join(worldDir, f);
    console.log(`Indexing ${f}...`);
    const content = await readFile(absPath, "utf8");
    await recall.upsertFile(f, content);
  }

  console.log("Successfully indexed all files under world/!");
}

main().catch(console.error);
