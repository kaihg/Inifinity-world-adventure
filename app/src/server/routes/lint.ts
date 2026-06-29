import type { FastifyInstance } from "fastify";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { runLint, formatLintReport } from "../../engine/lint.js";
import type { Logger } from "../../logger.js";

export function registerLintRoute(app: FastifyInstance, worldDir: string): void {
  app.post("/api/world/lint", async (_req, reply) => {
    const log = app.log as unknown as Logger;
    const issues = await runLint(worldDir, log);
    const report = formatLintReport(issues);
    await writeFile(path.join(worldDir, "lint-report.md"), report, "utf8");
    return reply.send({ ok: true, issueCount: issues.length, issues });
  });
}
