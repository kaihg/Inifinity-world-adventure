# 主空間 resume 提煉頁 now.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增有界、覆寫式的 `world/now.md`「當前局勢」提煉頁，作為唯一 resume 入口，讓新 session 不必讀無限增長的 `journal.md` 就能接回劇情。

**Architecture:** 補齊 wiki-llm 三層中主空間缺的「提煉頁」（對稱副本的 `wiki.md`）。`start-story` 先讀 `now.md` 恢復進度；回合收束協議每回合覆寫 `now.md`；`now.md` 的「進行中的副本」欄充當 resume 路由器。

**Tech Stack:** Markdown、Claude Code skills、git。本 repo **無測試框架**，每個任務的「驗證」為手動檢查或 grep。

## Global Constraints

- 全程繁體中文 + 台灣用詞，禁止簡體習慣用詞。
- `now.md` 為**覆寫式**（不是 append），永遠精簡，約 30–50 行封頂。
- resume 入口是 `now.md`，**不是** `journal.md`；`journal.md` 退為審計用 raw。
- 不新增 `/checkpoint`、`/stop-story`、`/continue-story` 指令；不接 agentmemory。
- 時間戳格式 `[YYYY-MM-DD]`。
- 對應設計文件：`docs/superpowers/specs/2026-06-19-resume-now-page-design.md`。
- 前置已完成：`2026-06-19-wiki-llm-turn-protocol`（journal、回合收束協議、Stop hook、index 鎖定事實、settle lint）。

---

### Task 1: 新增 `world/now.md`（覆寫式當前局勢快照）

**Files:**
- Create: `world/now.md`

**Interfaces:**
- Produces: `world/now.md` 作為 resume 提煉頁。Task 2（start-story 讀取與覆寫）、Task 3（enter-dungeon 覆寫）、Task 4（init-world 重建）、Task 5（CLAUDE.md 文件化）會引用。
- 固定欄位（後續任務的協議文字依賴這些欄名）：`當前篇章`、`此刻場景/地點`、`在場同伴/相關 NPC`、`進行中的副本`、`未解懸念/伏筆`、`主角下一步打算`、`最後更新`。

- [ ] **Step 1: 建立檔案**（內容反映目前實際故事狀態：安全區、已與葉晴結盟、準備 U-001、尚未進入任何副本）

寫入 `world/now.md`：

```markdown
# 當前局勢（Now）

> resume 入口：新 session 接劇情先讀這份（覆寫式快照，永遠精簡，約 30–50 行封頂）。
> 由回合收束協議每回合覆寫，不是 append；要回溯更早細節才翻 `journal.md` / `dungeons/<id>/runs/*.md`。

- 當前篇章：第一章·初次篩選——安全區整備，U-001「破曉城廢墟」開啟前
- 此刻場景/地點：主神空間安全區
- 在場同伴/相關 NPC：葉晴（yeqing，口頭結盟、戰術規劃）、林思雨（linsiyu，跟隨、情緒不穩定）
- 進行中的副本：無
- 未解懸念/伏筆：U-001 即將開啟；葉晴身份未經驗證；林思雨隱藏特質未知
- 主角下一步打算：完成安全區整備，準備進入 U-001
- 最後更新：[2026-06-19]
```

- [ ] **Step 2: 驗證**

Run: `grep -cE '^- (當前篇章|此刻場景|在場同伴|進行中的副本|未解懸念|主角下一步|最後更新)' world/now.md`
Expected: `7`（七個固定欄位齊全）。

Run: `wc -l < world/now.md`
Expected: 數值 `<= 50`（有界）。

- [ ] **Step 3: Commit**

```bash
git add world/now.md
git commit -m "feat: 新增主空間 resume 提煉頁 world/now.md"
```

---

### Task 2: `start-story` 讀取 now.md 並於收束覆寫

**Files:**
- Modify: `.claude/skills/start-story/SKILL.md`

**Interfaces:**
- Consumes: `world/now.md`（Task 1）的七個固定欄位，特別是「進行中的副本」欄用於路由。
- Produces: 主空間回合收束協議改為五步（記錄／提煉／索引／覆寫 now.md／提交）。

- [ ] **Step 1: step 1 讀取清單最前面加入 now.md 與路由說明**

把 `start-story/SKILL.md` 的這段：

```
1. **讀取必要狀態**（不要讀多餘文件）：
   - `world/setting.md`
   - `world/gm-notes.md`（保持暗線一致用，**不可**在對話中提前講出尚未揭露的內容）
   - `world/characters/index.md` → 按需再讀相關 `world/characters/<id>.md`
```

替換為：

```
1. **讀取必要狀態**（不要讀多餘文件）：
   - `world/now.md`（**resume 第一手**：當前篇章、此刻場景、在場同伴、進行中的副本、下一步；接劇情先讀這份，不要去讀整份 `journal.md`）
   - `world/setting.md`
   - `world/gm-notes.md`（保持暗線一致用，**不可**在對話中提前講出尚未揭露的內容）
   - `world/characters/index.md` → 按需再讀相關 `world/characters/<id>.md`
   - 若 `now.md`「進行中的副本」欄**不是「無」**：先用一兩句過渡敘事，再呼叫 `enter-dungeon` 接續該 `<dungeon-id>` + `<run-id>` 的 run，不要在主空間硬接副本劇情。
```

- [ ] **Step 2: 把回合收束協議改為五步（加入「覆寫 now.md」）**

把 `start-story/SKILL.md` 的整個「## 回合收束協議」專節（從 `## 回合收束協議（每個敘事回合結束時執行）` 到「4. **提交（git 層）**…」那一行為止）替換為：

```markdown
## 回合收束協議（每個敘事回合結束時執行）

每個敘事回合**結束時**依序執行；步驟 2–3 為條件式（本回合沒對應變動就略過），步驟 1、4、5 每回合都做。

**敘事前（query）**：重提任何已存在 NPC 前，先看 `world/characters/index.md` 的「鎖定事實」，細節不足才 Read 完整角色檔；不要憑印象派生設定。機率事件一律先呼叫 `roll-random`。

1. **記錄（raw 層）**：把本回合關鍵敘事＋骰子結果 append 到 `world/journal.md`，段落開頭帶時間戳 `## [YYYY-MM-DD] <一句標題>`。不重寫舊段，只增。
2. **提煉（wiki 層）**：把本回合**實際發生**的狀態變動寫進 canonical 檔——`world/characters/protagonist.md`（積分／屬性／技能／物品／buff-debuff）、出場 NPC 的 `world/characters/<id>.md`（關係／狀態變化）。
3. **索引（index 層）**：若本回合**新出現**一個 NPC/實體，在 `world/characters/index.md` 加一行＋一段「鎖定事實」。
4. **更新提煉頁（覆寫 `world/now.md`）**：覆寫（不是 append）七個欄位，反映本回合結束後的當前局勢；保持精簡（≤50 行），不要把 journal 內容塞進來。
5. **提交（git 層）**：commit 到當前分支（主空間不需要 PR），message 一句摘要，不要把整段敘事塞進 message。
```

- [ ] **Step 3: 驗證**

Run: `grep -c "world/now.md" .claude/skills/start-story/SKILL.md`
Expected: `>= 3`（step 1 讀取 + 路由說明 + 收束步驟 4）。

Run: `grep -c "更新提煉頁" .claude/skills/start-story/SKILL.md`
Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/start-story/SKILL.md
git commit -m "feat: start-story 讀取 now.md 並於收束覆寫，支援副本路由"
```

---

### Task 3: `enter-dungeon` 收束覆寫 now.md（含進行中副本欄）

**Files:**
- Modify: `.claude/skills/enter-dungeon/SKILL.md`

**Interfaces:**
- Consumes: `world/now.md`（Task 1）的「進行中的副本」欄。
- Produces: 副本回合收束協議改為五步。

- [ ] **Step 1: 把副本回合收束協議改為五步（加入「覆寫 now.md」）**

把 `enter-dungeon/SKILL.md` 的整個「## 回合收束協議（副本內每個敘事回合結束時執行）」專節（從該標題到 `> 注意：角色屬性/積分的「最終結算」…` 那段 blockquote 為止，含該 blockquote）替換為：

```markdown
## 回合收束協議（副本內每個敘事回合結束時執行）

每個敘事回合**結束時**依序執行；步驟 2–3 為條件式（本回合沒對應變動就略過），步驟 1、4、5 每回合都做。

**敘事前（query）**：重提任何已存在 NPC 前，先看 `world/characters/index.md` 的「鎖定事實」，細節不足才 Read 完整角色檔。機率判定一律先呼叫 `roll-random`，再依數值敘事。

1. **記錄（raw 層）**：把本回合關鍵敘事＋骰子結果 append 到 `world/dungeons/<dungeon-id>/runs/<run-id>.md`，段落開頭帶時間戳 `## [YYYY-MM-DD] <一句標題>`。append-only，不改舊段。
2. **提煉（wiki 層）**：把本回合**實際發生**且**已在劇情中揭露**的狀態變動寫進 canonical 檔——`world/characters/protagonist.md`、出場 NPC 的 `world/characters/<id>.md`、`world/dungeons/<dungeon-id>/wiki.md`（只寫已揭露的地圖/機關/規則，嚴守 `secrets.md`，未揭露不寫）。
3. **索引（index 層）**：若本回合**新出現**一個重要 NPC/實體，在 `world/characters/index.md` 加一行＋一段「鎖定事實」。
4. **更新提煉頁（覆寫 `world/now.md`）**：覆寫七個欄位反映副本內當前局勢，「進行中的副本」欄填 `<dungeon-id> + <run-id>`，確保在副本中暫停時 resume 能正確路由回本副本。保持精簡（≤50 行）。
5. **提交（git 層）**：commit 到副本 branch，message 一句摘要。

> 注意：角色屬性/積分的「最終結算」仍由 `settle-dungeon` 統一處理。回合中只記錄已明確發生的變動，不要在副本中途自行做新手保護等結算判定。
```

- [ ] **Step 2: 驗證**

Run: `grep -c "world/now.md" .claude/skills/enter-dungeon/SKILL.md`
Expected: `>= 1`

Run: `grep -c "更新提煉頁" .claude/skills/enter-dungeon/SKILL.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/enter-dungeon/SKILL.md
git commit -m "feat: enter-dungeon 收束覆寫 now.md，含進行中副本路由欄"
```

---

### Task 4: `init-world` 重建 now.md

**Files:**
- Modify: `.claude/skills/init-world/SKILL.md`

**Interfaces:**
- Consumes: `world/now.md`（Task 1）。

- [ ] **Step 1: 在步驟 5 的重建清單中，於 journal.md 那條之後新增 now.md 重建**

把 `init-world/SKILL.md` 的這一行：

```
   - 重建 `world/journal.md`：清空舊內容，只留標題與說明，並 append 一段 `## [YYYY-MM-DD] 新世界啟用` 起始時間戳。
```

替換為：

```
   - 重建 `world/journal.md`：清空舊內容，只留標題與說明，並 append 一段 `## [YYYY-MM-DD] 新世界啟用` 起始時間戳。
   - 重建 `world/now.md`：覆寫為新世界起始局勢——當前篇章=開場、此刻場景=主角初始位置、在場同伴=（無或開場既定）、進行中的副本=無、下一步=（開場行動）、最後更新=今日時間戳。
```

- [ ] **Step 2: 驗證**

Run: `grep -c "now.md" .claude/skills/init-world/SKILL.md`
Expected: `>= 1`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/init-world/SKILL.md
git commit -m "feat: init-world 重建 world/now.md"
```

---

### Task 5: `CLAUDE.md` 文件化 now.md 與 resume 約定

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 前述所有任務成果。

- [ ] **Step 1: 目錄結構 `world/` 區塊加入 now.md**

把 `CLAUDE.md` 目錄結構中的這一行：

```
  journal.md              # 主空間 raw 層：append-only、帶時間戳的原始時間線（與副本 runs/*.md 對稱）
```

替換為：

```
  journal.md              # 主空間 raw 層：append-only、帶時間戳的原始時間線（與副本 runs/*.md 對稱）
  now.md                  # 主空間提煉頁：覆寫式「當前局勢」快照，resume 入口（對稱副本 wiki.md）；讀這份接劇情，不讀 journal.md
```

- [ ] **Step 2: 核心循環第 2 點補 resume 約定**

把 `CLAUDE.md` 這段：

```
每個敘事回合結束都要跑「回合收束協議」（記錄→提煉→索引→提交），主空間記到 `world/journal.md`，副本記到 `runs/<run-id>.md`；協議定義見 `start-story`／`enter-dungeon` skill。
```

替換為：

```
每個敘事回合結束都要跑「回合收束協議」（記錄→提煉→索引→覆寫 now.md→提交），主空間 raw 記到 `world/journal.md`、副本記到 `runs/<run-id>.md`，並覆寫 `world/now.md` 當前局勢；協議定義見 `start-story`／`enter-dungeon` skill。**resume（新 session 接劇情）讀 `world/now.md`，不讀 `journal.md`**；`now.md` 的「進行中的副本」欄決定停在主空間或交給 `enter-dungeon`。
```

- [ ] **Step 3: 驗證**

Run: `grep -cE 'now.md' CLAUDE.md`
Expected: `>= 3`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 文件化 now.md 提煉頁與 resume 約定"
```

---

## 驗證計畫（全部任務完成後的整合手動驗證）

1. **resume 主空間**：跑一段 `start-story` 後結束 → 新 session 跑 `start-story`，確認先讀 `now.md` 接回當前場景與下一步，未讀整份 `journal.md`。
2. **resume 路由到副本**：副本中途結束 → 新 session 跑 `start-story`，確認 `now.md`「進行中的副本」欄有值，過渡後交給 `enter-dungeon` 接該 run。
3. **now.md 有界**：連跑多回合後，確認 `now.md` 仍 ≤50 行、為覆寫非堆積。
4. **init-world**：跑 `init-world` 後確認 `now.md` 重建為起始局勢、舊內容隨 `world/` 封存到 archives。
```
