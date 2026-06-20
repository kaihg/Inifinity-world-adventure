/** 切塊後的單一段落：heading 為所屬 `## ` 標題（無標題時為空字串） */
export interface Chunk {
  heading: string;
  text: string;
}

const MAX_CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 150;

/** 過長段落依字數切片，片間保留小量重疊避免斷句失去上下文 */
function splitByLength(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    parts.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - OVERLAP_CHARS;
  }
  return parts;
}

/**
 * 依本專案 Markdown 慣例（`## [日期] 標題` / `## 標題`）切塊；
 * 開頭無 `## ` 的內容（檔案標頭、單一角色檔等）併入 heading 為空字串的段落。
 */
export function chunkMarkdown(content: string): Chunk[] {
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "", lines: [] }];
  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      sections.push({ heading: line.slice(3).trim(), lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  const chunks: Chunk[] = [];
  for (const { heading, lines } of sections) {
    const text = lines.join("\n").trim();
    if (!text) continue;
    for (const part of splitByLength(text)) {
      chunks.push({ heading, text: part });
    }
  }
  return chunks;
}
