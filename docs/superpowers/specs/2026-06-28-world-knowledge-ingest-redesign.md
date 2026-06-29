# World Knowledge Ingest 重設計

**日期：** 2026-06-28  
**狀態：** 已通過第一性原理複審

---

## 問題陳述

目前 Layer 3 有三個根本性問題：

1. **secrets.md 品質差**：生成時缺乏量級約束，中級技能寫出宇宙級效果，普通水壺被包裝成隱藏道具
2. **固定 schema 限制 wiki 品質**：`excerpt` 欄位塞不下完整知識，且每次覆寫時不讀既有 wiki，累積知識會丟失
3. **entity 目錄結構是因 secrets.md 而存在**：`world/skills/邏輯推理（中級）/` 這種目錄只為了放兩個檔案，合併後沒有存在理由

---

## 核心決策

### 1. 廢除 secrets.md

隱藏設定合併進各主檔，用 section 分隔：

```markdown
# 邏輯推理

## 初級
...

## 中級
...

## 隱藏設定（不可提前揭露）
- 揭露條件：升至 B 級以上
- 真實來歷：...
- 隱藏效果：...
```

揭露時機由 prompt 指令控制（「僅在揭露條件達成時才在敘事中呈現」），不再靠檔案分離製造假隔離。

### 2. 扁平化 entity 檔案結構

```
world/skills/
  wiki.md           ← 分類索引（新增）
  邏輯推理.md       ← 單一檔，含各等級 + 隱藏設定（廢除子目錄）

world/dungeons/
  wiki.md           ← 副本索引（新增）
  命運樞紐.md       ← 單一副本檔（廢除 wiki.md/secrets.md 子目錄）

world/items/
  wiki.md
  <道具名>.md

world/scenes/
  wiki.md
  <場景名>.md
```

`lore.ts` 的 `loreDir()` 廢除，改用 `path.join(worldDir, category, id + ".md")` 直接定址。

### 3. journal.md 成為唯一敘事源

副本 `dungeons/<id>/log.md` 改為**結算時才生成**（從 journal.md 過濾本副本段落整理），不再每回合 real-time append。好處：前端永遠只需讀 `journal.md`，副本內的行動本就是完整劇情的一部份。

### 4. Layer 3 改為 Karpathy-style ingest pipeline

詳見下方架構章節。

### 5. 建立 asset-bible.md

`world/asset-bible.md`：全世界共通的生成約束規則（非故事內容，而是「什麼是可能的」）。所有新 entity 生成時必須先讀此檔。

---

## 架構：新 Layer 3 Ingest Pipeline

### 資料流

```
journal.md（唯一敘事源）
  ↓ 讀上次 ingest cursor（git commit hash）之後的新段落
  ↓
Step 1: Entity Extraction（一次 LLM call）
  輸入：新敘事段落 + asset-bible.md
  輸出：{ skills: ["邏輯推理"], characters: ["王大明"], dungeons: ["命運樞紐"], items: [], scenes: [] }
  ↓
Step 2: Parallel entity patch（每個 entity 一個 LLM call，同 category 可平行）
  輸入：entity.md 現有內容 + 新敘事片段 + asset-bible.md + templates/<category>.md
  輸出：完整新 entity.md 內容
  → 寫入 world/<category>/<entity>.md
  ↓
Step 3: Per affected category wiki rewrite（只跑被 Step 2 動到的分類）
  輸入：本次被更新的 entity.md 內容（不全掃）+ 現有 wiki.md + 分類索引格式說明
  輸出：完整新 wiki.md（full rewrite）
  → 寫入 world/<category>/wiki.md
  ↓
更新 ingest cursor（記錄本次 ingest 到 journal.md 的哪個 commit hash）
```

### Ingest Cursor

不引入新檔案格式。cursor 記錄在 `world/.ingest-cursor`（純文字，一行 git commit hash）。每次 ingest 完寫入，下次啟動時讀取，只處理 cursor 之後的新 journal 段落。

### 失敗降級

- Step 1 失敗：跳過本次 ingest，不更新 cursor（下次會重試）
- Step 2 單一 entity 失敗：略過該 entity，其他繼續，commit message 標記哪個 entity 失敗
- Step 3 失敗：wiki 索引暫時過時，下次 ingest 會修正（entity 本體已落地，不影響核心劇情）
- 全程不拋錯中斷回合（與現有行為一致）

### Ingest Cursor 機制

Layer 3 在 commit **之前** fire（async），不能用 git commit hash 當游標——hash 此時還是上一回合的值。

Cursor 改為 **journal.md 的 byte offset**（字元數）。格式：`world/.ingest-cursor`，純文字一行數字。每次 ingest 完寫入當前 `journal.md` 長度，下次從這個 offset 讀新段落。不依賴 git。

### 副本邊界標記

結算時要從 journal 重建 `dungeons/<id>/log.md`，需要明確的邊界。進入副本時由 dungeon-transition 在 journal append：

```
<!-- dungeon-start: 命運樞紐-run-001 2026-06-28T10:00:00 -->
```

結算時 append：

```
<!-- dungeon-end: 命運樞紐-run-001 -->
```

過濾靠標記，不靠行格式猜測。

### Layer 2 / Layer 3 職責邊界

**Layer 2 schema 只保留「done event 前必須就位」的欄位：**
```
now_changes, mode_transition, rolls,
suggested_actions, commit_summary, awaiting_user_input
```

`protagonist_points_delta`、`protagonist_changed`、`announced_dungeon` 從 Layer 2 schema 完全移除。

**主角狀態更新完全交給 Layer 3：** entity extraction 會抓出主角（Layer 1 敘事裡已寫「獲得 150 積分」），主角 entity 走同一套 read-then-rewrite，更新 `protagonist.md`。Layer 3 不需要排除主角——而是明確把主角當作一種特殊 entity 類型處理。

積分數字由 **Layer 1 主腦敘事決定**（寫進故事），Layer 3 從敘事中抽取，不重新計算。這樣積分變動在同一回合的敘事中就已呈現，不延遲到下回合。

### Step 2 Template 邏輯

- **已存在的 entity**：以現有 entity.md 結構為準，不套 template
- **新 entity**：用 `templates/<category>.md` 作為初始結構

### 與現有架構的對接

Layer 3 仍由 `scheduleLoreSync` 在回合結束後 fire（不 await），不卡 done event。差異是：
- 舊：從 fast-control 的 `touched_entities` 驅動，protagonist 由 Layer 2 delta 驅動
- 新：從 journal.md 最新段落自行 extract entities（含主角），完全不依賴 Layer 2 輸出

Layer 2 和 Layer 3 職責第一次真正乾淨分離：**Layer 2 只管 done 條件**，**Layer 3 管所有知識落地**。

---

## Asset Bible（初版大綱）

`world/asset-bible.md` 的初版結構，由 GM 填寫後才能正確約束生成：

```markdown
# Asset Bible

> 生成約束規則。所有技能/副本/道具生成前必須對照此文件。

## 技能分級尺度

| 等級 | 效果量級 | 副作用範圍 | 可觸碰的「系統層級」 |
|------|---------|-----------|-------------------|
| C    | 個人感知/反應 | 個人身上 | 不可觸碰 |
| B    | 影響小團體/環境 | 延伸至周圍環境 | 不可觸碰 |
| A    | 大範圍戰場 | 生態/社會層級 | 可察覺系統異常 |
| S    | 世界規則層 | 跨維度 | 可觸碰系統底層 |

**C 級技能範例（邏輯推理中級）**：個人層面的感知強化，副作用在個人精神/身體狀態上，
絕不可有「看見因果線」等 A 級才有的效果。

## 副本難度尺度

| 難度 | 基調 | 是否涉及主線暗線 | 敵人跨副本關聯 |
|------|------|----------------|--------------|
| 新手 | 生存/日常 | 否 | 否 |
| 進階 | 陰謀/懸疑 | 局部 | 可能 |
| 精英 | 世界真相 | 是 | 是 |

## 道具功率範圍

| 品質 | 效果上限 | 是否可有「隱藏設定」 |
|------|---------|-------------------|
| 普通 | 日常輔助 | 否（水壺就是水壺） |
| 稀有 | 戰術優勢 | 可選 |
| 史詩+ | 影響戰局 | 是 |

## 隱藏設定揭露原則

- 揭露條件必須明確（「升至 B 級以上」「完成第三次副本」）
- 揭露前完全不在敘事中呈現，不暗示，不鋪墊
- 量級不可超過 entity 所在等級/品質的上限
```

初版由 GM 填寫後，需要經過一輪 lint 驗證現有 entity 是否符合。

---

## Lint 工具

**觸發點：**
- `POST /api/world/lint`（GM 手動觸發）
- `settle_dungeon` 結算完後自動跑一次
- 每 N 回合 background job（N 可設定）

**檢查項目：**
- 技能/道具/副本等級是否符合 asset-bible 分級尺度
- journal 中出現的 entity 是否有對應的 wiki entry
- `now.md` 的狀態與 `protagonist.md` 的數值是否衝突
- 同一 entity 在不同檔案的描述是否矛盾
- `world/skills/wiki.md` 等索引是否與實際檔案一致

**輸出：** `world/lint-report.md`，列出問題但不自動修復（修復需要 GM 確認或另起 agent）。

---

## 遷移計畫（現有資料）

1. `world/skills/邏輯推理（中級）/secrets.md` 內容合併進新建的 `world/skills/邏輯推理.md`
2. `world/dungeons/<id>/wiki.md` + `secrets.md` 合併成 `world/dungeons/<id>.md`（注意：現在 dungeons 下是子目錄，這裡是把目錄「升格」成同名 `.md` 檔）
3. `world/scenes/` 下各場景目錄同上處理
4. `lore.ts` 的 `loreDir()`、`ensureSecrets()` 廢除；`loadLore()` 改為讀單一 `.md` 檔
5. `LoreSyncSchema` 整個廢除；`FastControlSchema` 移除 `protagonist_points_delta`、`protagonist_changed`、`announced_dungeon`（Layer 3 自行從 journal 抽取）
6. 建立 `world/asset-bible.md`（GM 人工填寫初版）
7. 建立 `world/<category>/wiki.md` 各分類索引（首次由 ingest 自動生成）

---

## 不在本次範圍

- 前端 UI 改動
- recall 索引（`engine/ingest.ts` 完成後，recall reindex 邏輯照舊接上）
- asset-bible 詳細內容（GM 人工定義，不是工程任務）
