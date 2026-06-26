import "dotenv/config";
import { buildServer } from "./app.js";
import { loadConfig, configWarnings } from "../config.js";
import { createLogger } from "../logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  for (const warning of configWarnings(config)) {
    logger.warn({ warning }, "設定警示");
  }

  const server = buildServer(config, { logger });

  try {
    await server.listen({ port: config.port, host: config.host });
    logger.info(
      { url: `http://${config.host}:${config.port}`, baseUrl: config.openai.baseUrl, model: config.openai.model, worldDir: config.worldDir },
      "無限世界冒險引擎已啟動",
    );
  } catch (err) {
    logger.error({ err }, "啟動失敗");
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info("收到終止信號，正在關閉伺服器…");
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main();
