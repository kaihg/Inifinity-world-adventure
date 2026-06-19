import "dotenv/config";
import { buildServer } from "./app.js";
import { loadConfig, configWarnings } from "../config.js";

async function main(): Promise<void> {
  const config = loadConfig();

  for (const warning of configWarnings(config)) {
    console.warn(`[設定警示] ${warning}`);
  }

  const server = buildServer(config);

  try {
    await server.listen({ port: config.port, host: "127.0.0.1" });
    console.log(`無限世界冒險引擎已啟動：http://127.0.0.1:${config.port}`);
    console.log(`LLM 後端：${config.openai.baseUrl}（model: ${config.openai.model}）`);
    console.log(`world/ 目錄：${config.worldDir}`);
  } catch (err) {
    console.error("啟動失敗：", err);
    process.exit(1);
  }
}

main();
