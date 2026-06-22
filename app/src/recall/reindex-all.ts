import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { listMarkdownFiles } from "./list-markdown-files.js";
import { createRecallIndex } from "./index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const worldDir = config.worldDir;
  const indexDir = config.recall.indexDir;

  console.log("Initializing Recall Index in:", indexDir);
  const recall = createRecallIndex(indexDir);

  const files = await listMarkdownFiles(worldDir);
  console.log(`Found ${files.length} markdown files in world/ to index.`);

  for (const file of files) {
    console.log(`Indexing ${file}...`);
    const content = await readFile(path.join(worldDir, file), "utf8");
    await recall.upsertFile(file, content);
  }

  console.log("Successfully indexed all files under world/!");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
