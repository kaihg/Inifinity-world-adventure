# wiki-llm 回合收束協議與一致性流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「無限流」文本站的狀態更新從靠自律改成「同回合耦合 + 確定性提醒」，並補上 Karpathy wiki-llm 模式缺的回合收束協議與一致性 lint。

**Architecture:** 純 Markdown + skill 規範 + 一個 Stop hook。三層對映：raw（`runs/*.md`、新增 `world/journal.md`）／wiki（`characters/*.md`、`wiki.md`）／schema（`CLAUDE.md`、`setting.md`、skills）。回合結束跑固定收束協議；settle 時用 subagent 做一致性 lint；Stop hook 用 git 髒狀態兜底。

**Tech Stack:** Markdown、Claude Code skills（`.claude/skills/*/SKILL.md`）、Claude Code hooks（`.claude/settings.json`）、git、shell。本 repo **無測試框架**，每個任務的「驗證」為手動檢查或模擬。

## Global Constraints

- 全程繁體中文 + 台灣用詞，禁止簡體習慣用詞（資訊/影片/軟體/網路/品質/記憶體…）。
- 角色狀態與 wiki 一律 Markdown，**禁止** sqlite / JSON 化狀態。
- 不引入第二真相來源（不接 agentmemory）、不加 mode 旗標、不接 codegraph。
- 回合收束協議步驟 2–4 為條件式：本回合無對應變動即略過。
- 時間戳格式固定 `## [YYYY-MM-DD] <一句標題>`。
- commit message 只寫摘要，不把整段敘事或 `gm-notes.md`/`secrets.md` 內容寫進 message（避免 git log 劇透）。
- 對應設計文件：`docs/superpowers/specs/2026-06-19-wiki-llm-turn-protocol-design.md`。

---

### Task 1: 新增 `world/journal.md`（主空間 raw 層）

**Files:**
- Create: `world/journal.md`

**Interfaces:**
- Produces: `world/journal.md` 作為主空間 append-only 原始時間線。Task 4（start-story）、Task 7（init-world）、Task 8（CLAUDE.md）會引用此檔。

- [ ] **Step 1: 建立檔案**

寫入 `world/journal.md`：

```markdown
# 主空間日誌（Journal）

> 主空間（副本之間：兌換積分、休整、NPC 互動、決定下一步）的 append-only 原始時間線，與副本的 `dungeons/<id>/runs/*.md` 對稱。
> 只增不改：每個敘事回合結束時，由回合收束協議 append 一段，段落開頭帶時間戳。
> 這是 raw 層（原始記錄），canonical truth 仍在 `characters/*.md`；提煉時讀這份回溯，不在這裡改寫歷史。

## [2026-06-19] 日誌啟用

主空間日誌建立。此前的主空間劇情記錄於 git 提交歷史中。
```

- [ ] **Step 2: 驗證**

Run: `head -5 world/journal.md`
Expected: 顯示標題與說明，無亂碼，繁體中文。

- [ ] **Step 3: Commit**

```bash
git add world/journal.md
git commit -m "feat: 新增主空間 raw 層 world/journal.md"
```

---

### Task 2: 新增 Stop hook（`.claude/settings.json`）

**Files:**
- Create: `.claude/settings.json`

**Interfaces:**
- Produces: 專案級 Stop hook，回合結束時若 `world/` 有未提交改動，block stop 並要求先 commit。

- [ ] **Step 1: 確認目前無 settings.json**

Run: `cat .claude/settings.json 2>/dev/null || echo "NONE"`
Expected: `NONE`（若已存在，改為把 `hooks.Stop` 併入現有檔，不要覆蓋其他設定）。

- [ ] **Step 2: 建立檔案**

寫入 `.claude/settings.json`：

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "if [ -n \"$(git status --porcelain world/ 2>/dev/null)\" ]; then printf '%s' '{\"decision\":\"block\",\"reason\":\"world/ 有未提交的世界狀態變更，請依回合收束協議步驟 4 先 commit 再結束本回合。\"}'; fi"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: 驗證 JSON 合法**

Run: `python3 -c "import json;json.load(open('.claude/settings.json'));print('OK')"`
Expected: `OK`

- [ ] **Step 4: 驗證 hook 指令邏輯（模擬 world/ 髒）**

Run: `touch world/__hooktest && bash -c 'if [ -n "$(git status --porcelain world/ 2>/dev/null)" ]; then echo DIRTY; else echo CLEAN; fi' && rm world/__hooktest`
Expected: `DIRTY`（證明條件能偵測未追蹤/未提交改動）。

- [ ] **Step 5: Commit**

```bash
git add .claude/settings.json
git commit -m "feat: 新增 Stop hook，world/ 未提交時提醒收束回合"
```

---

### Task 3: `characters/index.md` 升級為「鎖定事實檯帳」

**Files:**
- Modify: `world/characters/index.md`（整檔改寫）

**Interfaces:**
- Produces: `index.md` 新增「鎖定事實」區塊，每個 NPC 一段（外觀/身份/與主角關係/立場）。Task 4、Task 5 的 query 規範指向此區塊；Task 6 的 lint 比對此區塊。

- [ ] **Step 1: 改寫整檔**

把 `world/characters/index.md` 全檔替換為：

```markdown
# 角色索引（Character Index）

> 輕量索引，每次對話先讀這份，不要一開始就把所有角色檔案全讀進 context。
> **重提任何 NPC 前，先看下方「鎖定事實」**——那是絕不可寫矛盾的底線；細節不足才讀 `characters/<character-id>.md`。

| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |
|----|------|------|----------|--------------|
| protagonist | 沈奕 | 主角 | 安全區，已與葉晴口頭結盟，準備 U-001 | - |
| yeqing | 葉晴 | NPC / 潛在隊友 | 主動結盟，負責戰術規劃 | - |
| linsiyu | 林思雨 | NPC / 待保護對象 | 跟隨隊伍，情緒不穩定 | - |

## 鎖定事實（不可違背的底線）

> 新增 NPC 時，在表格加一行，並在這裡補一段鎖定事實。只放「絕不可前後矛盾」的硬設定，不放會隨劇情變動的近況（近況放上面表格或角色檔）。

### protagonist — 沈奕
- 外觀/出身：24 歲男性，城市自由搏擊俱樂部兼職教練，業餘打地下拳賽；長期格鬥訓練底子。
- 身份：本世界唯一玩家視角；某次夜歸途中被「主控系統」毫無徵兆選中傳送至安全區。
- 與主角關係：本人。
- 立場/性格：衝動、重情義、不輕易服輸；求生與成長。

### yeqing — 葉晴
- 外觀：約 37 歲女性，身材緊湊、肩膀寬實、核心線條明顯，掌心與指關節有密集淺疤；職業套裝，站姿與呼吸高度警覺。
- 身份（自述，未驗證）：前特種部隊教官；擅戰術規劃、應急醫療、系統規則解讀。
- 與主角關係：安全區資訊室主動接近並識破沈奕格鬥背景，達成口頭聯盟（她戰術規劃、沈奕直接衝突），尚未實戰驗證。
- 立場：傾向組隊（自陳年齡偏大、力量/敏捷不如年輕人）；信任建立在行動而非身份。

### linsiyu — 林思雨
- 外觀：約 18 歲高三女生，校服外套，臉色蒼白；初登場情緒不穩（發抖、反覆嘗試關閉系統面板）。
- 身份：心理脆弱的「風險變量」；隱藏能力/特質未知。
- 與主角關係：主動跟隨沈奕與葉晴但保持距離；沈奕不主動救她、人情成本低才順手；葉晴單方面承諾保她活下來，沈奕未明確附議。
- 立場：待保護對象，尚未證明自救能力。
```

- [ ] **Step 2: 驗證**

Run: `grep -c "^### " world/characters/index.md`
Expected: `3`（三個鎖定事實條目）。

確認鎖定事實與 `characters/protagonist.md`、`yeqing.md`、`linsiyu.md` 內容不矛盾（人工對讀一次年齡、外觀、關係）。

- [ ] **Step 3: Commit**

```bash
git add world/characters/index.md
git commit -m "feat: index.md 升級為鎖定事實檯帳"
```

---

### Task 4: `start-story` 加回合收束協議（主空間版）

**Files:**
- Modify: `.claude/skills/start-story/SKILL.md`

**Interfaces:**
- Consumes: `world/journal.md`（Task 1）、`index.md` 鎖定事實（Task 3）。
- Produces: 主空間回合收束協議的權威定義，Task 8（CLAUDE.md）會引用。

- [ ] **Step 1: 改寫「步驟」第 3 條，指向新協議**

把 `start-story/SKILL.md` 中這一行：

```
3. **狀態變更隨手 commit**：兌換積分、領取獎勵、NPC 關係變化等，直接更新對應的 `world/characters/*.md`，commit 到當前分支（不需要 PR，因為沒有進副本）。
```

替換為：

```
3. **每回合結束跑「回合收束協議」**（見下方專節）：把本回合的記錄、狀態提煉、索引更新、提交一次做完，不留「之後再收斂」的延遲點。
```

- [ ] **Step 2: 在「## 步驟」區塊之後、「## 敘事語言規範」之前，插入新專節**

插入：

```markdown
## 回合收束協議（每個敘事回合結束時執行）

每個敘事回合**結束時**依序執行；步驟 2–4 為條件式，本回合沒對應變動就略過。多數回合只做步驟 1＋4。

**敘事前（query）**：重提任何已存在 NPC 前，先看 `world/characters/index.md` 的「鎖定事實」，細節不足才 Read 完整角色檔；不要憑印象派生設定。機率事件一律先呼叫 `roll-random`。

1. **記錄（raw 層）**：把本回合關鍵敘事＋骰子結果 append 到 `world/journal.md`，段落開頭帶時間戳 `## [YYYY-MM-DD] <一句標題>`。不重寫舊段，只增。
2. **提煉（wiki 層）**：把本回合**實際發生**的狀態變動寫進 canonical 檔——`world/characters/protagonist.md`（積分／屬性／技能／物品／buff-debuff）、出場 NPC 的 `world/characters/<id>.md`（關係／狀態變化）。
3. **索引（index 層）**：若本回合**新出現**一個 NPC/實體，在 `world/characters/index.md` 加一行＋一段「鎖定事實」。
4. **提交（git 層）**：commit 到當前分支（主空間不需要 PR），message 一句摘要，不要把整段敘事塞進 message。
```

- [ ] **Step 3: 驗證**

Run: `grep -c "回合收束協議" .claude/skills/start-story/SKILL.md`
Expected: `>= 2`（步驟 3 的引用 + 專節標題）。

Run: `grep -c "隨手 commit" .claude/skills/start-story/SKILL.md`
Expected: `0`（舊的自律式描述已移除）。

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/start-story/SKILL.md
git commit -m "feat: start-story 加回合收束協議（主空間版）"
```

---

### Task 5: `enter-dungeon` 加回合收束協議（副本版）

**Files:**
- Modify: `.claude/skills/enter-dungeon/SKILL.md`

**Interfaces:**
- Consumes: `index.md` 鎖定事實（Task 3）。
- Produces: 副本回合收束協議定義（寫 `runs/<run-id>.md` 與 `wiki.md`）。

- [ ] **Step 1: 改寫「步驟 5：開始敘事」的最後一個 bullet**

把這一行：

```
   - 每個回合/關鍵節點，把對話進展 append 到 `runs/<run-id>.md` 並 commit（不要等到最後一次性寫完整段劇情再 commit，方便保留時間序的真實記錄）。
```

替換為：

```
   - 每個回合結束跑「回合收束協議」（見下方專節），逐回合 append + commit，不要等到最後一次性寫完。
```

- [ ] **Step 2: 在「## 注意」區塊之前插入新專節**

插入：

```markdown
## 回合收束協議（副本內每個敘事回合結束時執行）

每個敘事回合**結束時**依序執行；步驟 2–4 為條件式，本回合沒對應變動就略過。

**敘事前（query）**：重提任何已存在 NPC 前，先看 `world/characters/index.md` 的「鎖定事實」，細節不足才 Read 完整角色檔。機率判定一律先呼叫 `roll-random`，再依數值敘事。

1. **記錄（raw 層）**：把本回合關鍵敘事＋骰子結果 append 到 `world/dungeons/<dungeon-id>/runs/<run-id>.md`，段落開頭帶時間戳 `## [YYYY-MM-DD] <一句標題>`。append-only，不改舊段。
2. **提煉（wiki 層）**：把本回合**實際發生**且**已在劇情中揭露**的狀態變動寫進 canonical 檔——`world/characters/protagonist.md`、出場 NPC 的 `world/characters/<id>.md`、`world/dungeons/<dungeon-id>/wiki.md`（只寫已揭露的地圖/機關/規則，嚴守 `secrets.md`，未揭露不寫）。
3. **索引（index 層）**：若本回合**新出現**一個重要 NPC/實體，在 `world/characters/index.md` 加一行＋一段「鎖定事實」。
4. **提交（git 層）**：commit 到副本 branch，message 一句摘要。

> 注意：角色屬性/積分的「最終結算」仍由 `settle-dungeon` 統一處理（步驟 6）。回合中只記錄已明確發生的變動，不要在副本中途自行做新手保護等結算判定。
```

- [ ] **Step 3: 驗證**

Run: `grep -c "回合收束協議" .claude/skills/enter-dungeon/SKILL.md`
Expected: `>= 2`

Run: `grep -c "嚴守 \`secrets.md\`\|嚴守 secrets" .claude/skills/enter-dungeon/SKILL.md`
Expected: `>= 1`（確認 wiki 揭露限制有寫進協議）。

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/enter-dungeon/SKILL.md
git commit -m "feat: enter-dungeon 加回合收束協議（副本版）"
```

---

### Task 6: `settle-dungeon` 加一致性 lint subagent

**Files:**
- Modify: `.claude/skills/settle-dungeon/SKILL.md`

**Interfaces:**
- Consumes: `index.md` 鎖定事實（Task 3）、回合收束協議產出的 `runs/*.md`。
- Produces: settle 流程的 lint 步驟。

- [ ] **Step 1: 在現有步驟 1 之後、步驟 2 之前，插入新步驟（並把後續步驟順延編號）**

在 `settle-dungeon/SKILL.md` 的步驟 1（讀取 run 記錄）與步驟 2（判定結束類型）之間，插入新的一步：

```markdown
2. **一致性檢查（lint）**：在提煉進 wiki 前，派一個 `Explore` subagent，拿 `runs/<run-id>.md` 比對既有 `world/dungeons/<dungeon-id>/wiki.md`、相關 `world/characters/*.md`、`world/characters/index.md` 的「鎖定事實」，請它回報**矛盾清單**：NPC 細節漂移（外觀/身份/關係與鎖定事實不符）、過時宣稱、劇情前後牴觸、孤立或無依據的新事實。
   - **重要**：`world/gm-notes.md`／`world/dungeons/<dungeon-id>/secrets.md` 牴觸 `setting.md`／`wiki.md` 是**設計上的隱藏層（隱藏 vs 揭露）**，**不是矛盾**，subagent 不可把它列為矛盾——必須在派工說明裡明確告知這點。
   - 有矛盾 → 在後續提煉/更新角色狀態時**先修正敘事認定或明確標註**，再合併；不要把矛盾原樣寫進 canonical 檔。
   - subagent 只負責回報結論，不直接寫文件。
```

並把原步驟 2～6 順延為 3～7（更新所有「步驟 N」與「步驟 6 合併」之類的內部引用）。

- [ ] **Step 2: 驗證**

Run: `grep -c "一致性檢查\|lint" .claude/skills/settle-dungeon/SKILL.md`
Expected: `>= 1`

Run: `grep -c "隱藏 vs 揭露\|不是矛盾" .claude/skills/settle-dungeon/SKILL.md`
Expected: `>= 1`（確認隱藏層教導有寫入）。

確認步驟編號連續無重複（人工掃一次步驟列表）。

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/settle-dungeon/SKILL.md
git commit -m "feat: settle-dungeon 加一致性 lint subagent 步驟"
```

---

### Task 7: `init-world` 納入 `world/journal.md` 歸檔與重建

**Files:**
- Modify: `.claude/skills/init-world/SKILL.md`

**Interfaces:**
- Consumes: `world/journal.md`（Task 1）。

- [ ] **Step 1: 在步驟 5「寫入新設定」的清單中，補一條重建 journal**

在 `init-world/SKILL.md` 步驟 5 既有的子項（改寫 setting、gm-notes、protagonist、清空 index、清空 dungeons）之中，新增一條：

```
   - 重建 `world/journal.md`：清空舊內容，只留標題與說明，並 append 一段 `## [YYYY-MM-DD] 新世界啟用` 起始時間戳。
```

- [ ] **Step 2: 確認步驟 2「封存舊世界」已涵蓋 journal**

步驟 2 是「將整個 `world/` 目錄複製到 archives」，`journal.md` 在 `world/` 下，已自動隨整目錄封存，無需額外修改。人工確認步驟 2 文字是「整個 `world/` 目錄」而非逐檔列舉。

- [ ] **Step 3: 驗證**

Run: `grep -c "journal.md" .claude/skills/init-world/SKILL.md`
Expected: `>= 1`

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/init-world/SKILL.md
git commit -m "feat: init-world 重建 world/journal.md"
```

---

### Task 8: 更新 `CLAUDE.md`（journal、回合收束協議、log 約定）

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 前述所有任務的成果，作為 schema 層的權威說明。

- [ ] **Step 1: 在「## 目錄結構」的 `world/` 區塊加入 journal.md**

在 `CLAUDE.md` 目錄結構的 `world/` 下、`setting.md` 與 `gm-notes.md` 附近，加入：

```
  journal.md              # 主空間 raw 層：append-only、帶時間戳的原始時間線（與副本 runs/*.md 對稱）
```

- [ ] **Step 2: 在「## 核心循環」第 2 點補回合收束協議**

把核心循環第 2 點末尾補一句：

```
每個敘事回合結束都要跑「回合收束協議」（記錄→提煉→索引→提交），主空間記到 `world/journal.md`，副本記到 `runs/<run-id>.md`；協議定義見 `start-story`／`enter-dungeon` skill。
```

- [ ] **Step 3: 在「## 關鍵約定」新增兩條**

新增：

```
- **raw log 用檔案 append，不用 commit message 當 log，不用 sqlite**：原始記錄逐回合 append 到 `runs/*.md`／`journal.md`，commit message 只寫摘要。否決 sqlite（二進位殺掉 git 防竄改與 PR 合併、違背 markdown 哲學）與「commit message 當 log」（純敘事回合需空 commit 當載體、提煉要靠 git log 撈）。
- **回合收束 + Stop hook 兜底**：狀態變動在發生的同一回合就寫入 canonical 檔（不留延遲結帳點）；`.claude/settings.json` 的 Stop hook 會在 `world/` 有未提交改動時提醒先 commit。一致性靠「敘事前讀 index 鎖定事實」與「settle 時的 lint subagent」雙重把關。
```

- [ ] **Step 4: 驗證**

Run: `grep -c "journal.md\|回合收束\|Stop hook" CLAUDE.md`
Expected: `>= 3`

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 補 journal、回合收束協議與 log 約定"
```

---

## 驗證計畫（全部任務完成後的整合手動驗證）

1. **Stop hook**：在 `world/` 製造未提交改動 → 結束一回合 → 確認被要求先 commit；`world/` 乾淨時不觸發。
2. **主空間協議**：跑一段 `start-story`（含一次積分變動 + 一個新 NPC 出場）→ 確認 `journal.md` append、`protagonist.md` 更新、`index.md` 新增鎖定事實、各自 commit。
3. **一致性 lint**：在一個 run log 故意埋與 index 鎖定事實矛盾的 NPC 細節 → 跑 `settle-dungeon` → 確認 subagent 回報該矛盾，且**不**把 secrets/gm-notes 隱藏層誤報為矛盾。
4. **query 路徑**：重提既有 NPC 時，確認先讀 index 鎖定事實而非憑印象。
```
