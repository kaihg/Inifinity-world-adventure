import { readdir, access } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface LintIssue {
  severity: "error" | "warn";
  file: string;
  message: string;
}

const LORE_CATEGORIES = ["skills", "items", "scenes", "dungeons"] as const;

export async function runLint(worldDir: string, log: Logger): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  for (const cat of LORE_CATEGORIES) {
    const catDir = path.join(worldDir, cat);
    let entityFiles: string[] = [];
    try {
      const entries = await readdir(catDir, { withFileTypes: true });
      entityFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "wiki.md")
        .map((e) => e.name);
    } catch {
      // Directory doesn't exist — skip quietly
      continue;
    }

    if (entityFiles.length > 0) {
      const wikiPath = path.join(catDir, "wiki.md");
      try {
        await access(wikiPath);
      } catch {
        log.warn({ cat, entityFiles }, `${cat}/wiki.md 不存在`);
        issues.push({
          severity: "warn",
          file: wikiPath,
          message: `${cat}/wiki.md 不存在，但有 ${entityFiles.length} 個 entity 檔案`,
        });
      }
    }
  }

  return issues;
}

export function formatLintReport(issues: LintIssue[]): string {
  if (issues.length === 0) return "# Lint 報告\n\n✅ 無問題\n";
  const lines = issues.map((i) => `- [${i.severity.toUpperCase()}] ${i.file}: ${i.message}`);
  return `# Lint 報告\n\n共 ${issues.length} 個問題：\n\n${lines.join("\n")}\n`;
}
