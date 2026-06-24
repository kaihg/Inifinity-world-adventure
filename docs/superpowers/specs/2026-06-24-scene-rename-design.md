# Scene Rename 設計文件

**日期**：2026-06-24  
**背景**：引擎原本用 `location` / `locations` 稱呼場景類實體（`world/locations/<id>/wiki.md`、schema category `"location"`），但 template 設計與 `now.md` 欄位都用 `scene` / `場景`。統一為 `scene` 可消除混淆。

---

## 目標

- 引擎所有 `location` → `scene`（schema category、LoreCategory、變數名、目錄名）
- `templates/scene.md` 骨架內容同步確認（已存在，格式正確）
- `world/locations/` 目前不存在，無資料遷移需求

---

## 改動範圍

### Production

| 檔案 | 改動 |
|------|------|
| `app/src/engine/lore.ts` | `LoreCategory` 的 `"locations"` → `"scenes"` |
| `app/src/engine/schema.ts` | category enum `"location"` → `"scene"` |
| `app/src/engine/turn/lore-rewrite.ts` | `ENTITY_SECRETS_DESIGNER_ROLE` / `ENTITY_CATEGORY_TO_LORE` / `ENTITY_CATEGORY_TITLE` / `LoreRewriteCategory` 的 `location` → `scene`，`"locations"` → `"scenes"` |
| `app/src/engine/turn/index.ts` | `existingLocationIds` → `existingSceneIds`；`listLoreIds(worldDir, "locations", ...)` → `"scenes"` |
| `app/src/engine/turn/lore-sync.ts` | `locationIds` → `sceneIds`；`"locations"` → `"scenes"`；Set key `location:` → `scene:` |
| `app/src/engine/turn/prompts.ts` | prompt 字串 `location` → `scene`（兩處） |
| `app/src/engine/world-ops.ts` | 一處註解 `locations/` → `scenes/` |

### Tests

| 檔案 | 改動 |
|------|------|
| `app/src/engine/schema.test.ts` | category `"location"` → `"scene"` |
| `app/src/engine/lore.test.ts` | `"locations"` → `"scenes"`；路徑 `locations/` → `scenes/` |
| `app/src/engine/world-ops.test.ts` | `seedDirtyWorld` 目錄 `locations/` → `scenes/`；斷言路徑同步 |
| `app/src/engine/turn/lore-rewrite.test.ts` | `"location"` → `"scene"` |
| `app/src/engine/turn/lore-sync-validate.test.ts` | Set key `location:` → `scene:` |
| `app/src/engine/turn/prompts.test.ts` | prompt 字串斷言 `location` → `scene` |

### 目錄（世界資料）

- `world/locations/` 不存在，無需 mv
- `resetWorldToPlaceholder` 不涉及（動態目錄，整個清掉重建）

---

## templates/scene.md 骨架（確認）

已存在於 `templates/scene.md`，格式正確：

```markdown
# 場景：{{場景名稱}}

## 外觀
## 氛圍
## 已知資訊
## 備註
```

不需要修改。

---

## 不在本次範圍

- `now.md` 欄位「此刻場景/地點」已是繁體描述，不涉及 code key 改名
- `CLAUDE.md` 目錄結構已在 Task 4 的 fix commit 裡反映 `scenes/`（若未反映則補）
