# 將 world_uuid 移至 world/meta.json

## 背景

`world-id.ts` 的 `injectWorldUuid` 把 UUID 注入 `setting.md` 第二行：

```
- 世界 UUID：702157d6-507a-457c-964c-5d8ef724d46f
```

`setting.md` 整份內容作為 `settingText` 進入 Layer 1 narrative prompt，導致 LLM 看見這個 UUID 並「借用」為敘事元素（e.g. 主角執行者編號加上自創後綴 `-001`）。世界 UUID 是引擎內部識別符，不屬於故事世界，不應出現在 narrative context。

## 設計

將 UUID 移至 `world/meta.json`（JSON 格式，引擎顯式讀取，不進入 narrative prompt）。現有世界不需遷移——使用者可建立新世界獲得乾淨狀態。

### `world/meta.json` 格式

```json
{ "worldUuid": "702157d6-507a-457c-964c-5d8ef724d46f" }
```

### 變更：`app/src/engine/world-id.ts`

**移除** `injectWorldUuid`：

```typescript
// 刪除整個函式
export function injectWorldUuid(settingMd: string, worldUuid: string): string { ... }
```

**新增** `writeWorldMeta`：

```typescript
export async function writeWorldMeta(worldDir: string, worldUuid: string): Promise<void> {
  await writeFile(
    path.join(worldDir, "meta.json"),
    JSON.stringify({ worldUuid }) + "\n",
    "utf8",
  );
}
```

**修改** `readWorldUuid`（介面不變，改讀 `meta.json`）：

```typescript
export async function readWorldUuid(worldDir: string): Promise<string> {
  const content = await readFile(path.join(worldDir, "meta.json"), "utf8");
  const parsed = JSON.parse(content) as { worldUuid?: string };
  if (!parsed.worldUuid) throw new Error("meta.json 中找不到 worldUuid");
  return parsed.worldUuid;
}
```

### 變更：`app/src/engine/world-ops.ts`

`initWorld` 的步驟 1 平行讀取（template 讀取）不動；步驟 3（設定生成後）原本的 `injectWorldUuid` 呼叫改為 `writeWorldMeta`：

```typescript
// 改前（步驟 3 附近）
const settingMd = injectWorldUuid(settingMdRaw, worldUuid);
await writeFile(path.join(worldDir, "setting.md"), settingMd, "utf8");

// 改後
await writeWorldMeta(worldDir, worldUuid);
await writeFile(path.join(worldDir, "setting.md"), settingMdRaw, "utf8");
```

import 改為移除 `injectWorldUuid`，新增 `writeWorldMeta`：

```typescript
import { generateWorldUuid, writeWorldMeta, readWorldUuid } from "./world-id.js";
```

`endWorld` 不需修改：其呼叫的 `readWorldUuid(worldDir)` 介面不變，只是底層改讀 `meta.json`。

### 不動的檔案

| 檔案 | 理由 |
|------|------|
| `archive.ts` | 接受 `worldUuid: string` 參數，不關心來源 |
| `protagonist-epitaph.ts` | 呼叫 `readWorldUuid(worldDir)`，介面不變 |
| `player-meta.ts` | 接受 `worldUuid` 字串存入 epitaph，不關心來源 |
| `turn/index.ts` | 不讀 UUID |

### 測試：`app/src/engine/world-ops.test.ts`

**更新**「initWorld 會把 world_uuid 寫進 setting.md」：

```typescript
it("initWorld 會把 world_uuid 寫進 meta.json，不寫進 setting.md", async () => {
  // ...（執行 initWorld）...
  const meta = JSON.parse(await readFile(path.join(worldDir, "meta.json"), "utf8"));
  expect(meta.worldUuid).toMatch(/^[a-f0-9-]{36}$/);

  const setting = await readFile(path.join(worldDir, "setting.md"), "utf8");
  expect(setting).not.toMatch(/世界 UUID/);
});
```

**更新**「readWorldUuid 從 setting.md 讀取並回傳 UUID」→ 改為透過 `writeWorldMeta` 建立測試前置：

```typescript
it("readWorldUuid 從 meta.json 讀取並回傳 UUID", async () => {
  await writeWorldMeta(worldDir, "test-uuid-1234");
  const uuid = await readWorldUuid(worldDir);
  expect(uuid).toBe("test-uuid-1234");
});
```

**更新**「readWorldUuid 找不到 UUID 時拋出錯誤」：維持不存在 `meta.json` 的情境（不需改動，原本 `setting.md` 沒有 UUID 就拋錯，現在 `meta.json` 不存在也拋錯）。

## 影響

| | 改前 | 改後 |
|--|------|------|
| UUID 儲存位置 | `setting.md` L3 | `world/meta.json` |
| UUID 是否進入 Layer 1 prompt | ✅ 是（隨 settingText 注入） | ❌ 否（引擎顯式讀取） |
| `readWorldUuid` 介面 | 不變 | 不變（呼叫端零改動） |
| `injectWorldUuid` | 存在 | 移除 |
| `writeWorldMeta` | 不存在 | 新增 |
| `endWorld` / `protagonist-epitaph` | 不動 | 不動 |

## 不在本次範圍

- 現有世界遷移：使用者重建世界即可獲得乾淨狀態
- `meta.json` 其他欄位：之後有需要再擴充
- Issue 1、2、8：另立 spec
