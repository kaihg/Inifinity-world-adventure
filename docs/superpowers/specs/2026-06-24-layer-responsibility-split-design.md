# Layer 權責重劃 + protagonist 全檔重寫 + Bug 2/4/5 prompt 收緊

## Context（為什麼要做）

延續上一輪「落地層護欄」修正後，再跑 10 回合（共 20 個自動推進回合）做 E2E 驗證，發現上一輪修好的問題（重複角色檔、簡體字、index 貼錯位置、佈景過度建檔的水壺/兌換面板等）皆未再現，但浮出 4 個**新一批殘留 bug**：

1. **Bug 1 — `protagonist.md` 屬性/物品重複落地**：Layer 2 輸出的 `protagonist_updates` 是短名稱片段（如 `"力量"`、`"多功能戰術刀"`），引擎 append 進 `protagonist.md` 時用字串比對 dedup，但既有條目是完整描述（`"力量：中等偏上（長期格鬥訓練底子）"`、`"系統配給基礎裝備：一把多功能戰術刀"`），格式不一致導致去重失效，重複條目穿過。**根因是 delta-append 模型本身**：模型給片段、引擎機械拼接，無法對齊既有完整條目。
2. **Bug 2 — 技能/實體 id 語意不符**：7B 對「辨識震動」技能輸出 `id: "system_monitor"`（系統視角功能描述詞，而非實體本身的名字）。目錄名與內容對不上。Gate 攔不住（`system_monitor` 是合法 slug）。
3. **Bug 4 / 5 — wiki / 角色檔末段混入 raw 敘事**：`callLoreRewrite` 把 `excerpt`（敘事原文）整段搬進輸出，wiki 文件末尾出現「沈奕拿起警報器逃離……」「【系統公告】【副本載入完畢】」等原始敘事散文與系統提示，而非提煉過的知識條目。

> Bug 3（佈景過度建檔，如 `safety_zone_lighting` 純照明環境被建為 location 實體）**這次不在範圍內**——暫無可靠解，prompt 已試過收緊但 7B 仍會建，留待日後。

E2E 過程中 Layer 2 control LLM 的 JSON 輸出**全程無解析錯誤**（20 個回合 `回合結束（Layer 2）` 全為 INFO 級，無 ERROR / parse 失敗），故本次不涉及 JSON 解析強健性。

## 設計目標

1. **重劃 Layer 2/3 權責**：Layer 2 只負責「玩家這回合的即時體驗」，除 `now` 外所有「世界狀態更新」歸 Layer 3。
2. **protagonist 改全檔重寫**：根治 Bug 1（dedup 永遠對不齊的結構性問題）。
3. **三條 prompt 收緊**：Bug 2（id 直譯）、Bug 4/5（禁止照搬敘事散文）。

本次**只動 `app/` 引擎與測試**，不修現有壞檔（符合 CLAUDE.md 劇情/開發分離；壞檔是試跑產物）。

---

## 1. 架構與責任邊界

把「世界狀態更新」從 Layer 2 整批移到 Layer 3，Layer 2 瘦身成純粹的「玩家當下要看什麼」。

```
Layer 2（fast-control）── 玩家這回合的即時體驗
  輸入：敘事
  輸出：now（七欄覆寫）/ rolls / awaiting_user_input
        / suggested_actions / commit_summary / mode_transition / transition_*
  落地：done event 之前同步寫 now.md（面板即時）

Layer 3（reactive-lore-sync）── 世界因本回合產生的變化
  輸入：敘事 + protagonist.md 全文 + 現有實體 id 清單
  輸出：protagonist_points_delta（數字，引擎決定論加減）
        + protagonist_full（整檔重寫內容，取代 append/dedup）
        + touched_entities（NPC/item/location/skill）
        + dungeon_wiki_excerpt
  落地：背景任務，done 之後
```

**Schema 變更：**
- 從 `FastControlSchema.state_changes` **移除** `protagonist_points_delta`、`protagonist_updates`。
- `FastControlSchema.state_changes` 保留 `now`（面板即時顯示核心，必須 done 前落地）。
- 在 `LoreSyncSchema.state_changes` **新增** `protagonist_points_delta: number`（可選）與 `protagonist_changed: boolean`（可選，預設 false，標記本回合主角是否有屬性/技能/物品/buff 變化）。protagonist 全檔內容**不走 schema 欄位**，而是引擎在 Layer 3 內另呼叫 `callProtagonistRewrite` 取得（與 NPC/wiki 重寫一致：觸發才重寫，不在主 JSON 裡塞整檔）。

**積分延遲一回合（已拍板接受，方案 A）：**
- 現況 `protagonist.md` 在 Layer 2、done event 之前同步落地，面板即時看到新積分。
- 移到 Layer 3（背景任務，done 之後）後，積分與 protagonist 更新會**延遲一回合**才反映到面板——與既有 NPC 更新的延遲行為一致（CLAUDE.md 已註明「done 時 NPC 可能仍是上一回合值」）。
- 下一回合開始時 `loadState` 會讀到正確值。慢節奏文字遊戲中積分晚一回合顯示幾乎無感。
- **零前端改動**：不新增 SSE 二次 `state` 事件、不動 `TurnEvent`、不動 server/前端。日後若要「面板全即時」再單獨做。

---

## 2. protagonist 全檔重寫（根治 Bug 1）

對標 `callLoreRewrite`，protagonist 從「delta-append」改為「整檔重寫」。

**落地流程（在 `runLoreSync` 內）：**
```
1. Layer 3 輸出 protagonist_points_delta（純數字）
2. 引擎先跑 applyPointsDelta(protagonist.md, delta)   ← 決定論算術，不信任 7B 算總值
3. 引擎把「積分已更新的 protagonist.md 全文」+ 本回合敘事 excerpt
   餵給 callProtagonistRewrite（新函式，類比 callLoreRewrite）
4. 模型回傳整份新版 protagonist.md（自己整合屬性/技能/物品成長，天然無重複）
5. 引擎整檔覆寫 protagonist.md
```

**關鍵設計點：**
- **積分絕不進重寫模型的「可改」範圍**：步驟 2 先決定論落地積分，步驟 3 重寫時積分已是正確值寫在檔裡，prompt 明令「積分區塊照抄、不可改動」。7B 永遠不碰算術。
- **沿用 `callLoreRewrite` 嚴格鐵則**：「不可遺漏現有文件中仍成立的事實」「只在敘事明確提供新資訊時才改動」——同時防「重寫漏抄既有屬性」與「無中生有」。
- **觸發條件**：在 `LoreSyncSchema.state_changes` 新增一個布林訊號 `protagonist_changed`（可選，預設 false），由 Layer 3 判斷「本回合敘事是否涉及主角屬性/技能/物品/buff 的變化」。**當 `protagonist_points_delta !== 0` 或 `protagonist_changed === true` 時才重寫**；兩者皆否則完全跳過 protagonist 處理（避免無謂的整檔 in/out）。不靠引擎自己從敘事猜成長——交給已在讀敘事的 Layer 3 一個明確布林欄位，最省且不模糊。

**移除的程式碼：**
- `turn-core.ts` 中 protagonist 的積分/updates 落地段（`applyPointsDelta` + `applyProtagonistUpdates` 呼叫）整段移除——改由 Layer 3 處理。
- `context.ts` 的 `applyProtagonistUpdates`；`appendToSection` 與 `normalizeItem` 若無其他呼叫者則一併刪除（先 grep 確認）。
- `applyPointsDelta` **保留**（移到 Layer 3 呼叫）。

**取捨：** 全檔重寫比 delta 多一次完整檔案 token，且有「7B 重寫漏抄」風險。但 protagonist.md 短（~40 行），成本可控；漏抄風險由「現有全文照抄非變更部分」鐵則壓低。與 wiki/NPC 已驗證的全檔重寫同一套模式。

---

## 3. Bug 2 / 4 / 5 prompt 收緊

三者都是「7B 局部無視既有規則」，全部在 prompt 層加約束 + 正反例，不動引擎決定論流程。

**Bug 2 — id 語意不符**
位置：`prompts.ts` 的 `LORE_SYNC_FORMAT_BLOCK`，`touched_entities.id` 說明。
現況只說「小寫英數 snake_case」，未約束 id 與 name 的關係。新增：

> id 必須是 `name` 的英文直譯（snake_case），例如「辨識震動」→ `identify_vibration`、「碰撞警報裝置」→ `collision_alarm_device`。**不可用系統視角的功能描述詞**（如 `system_monitor`、`handler`、`manager`、`detector`）取代實體本身的名字。

**Bug 4 / 5 — wiki / 角色檔末段混入 raw 敘事**
位置：`lore-rewrite.ts` 的 `callLoreRewrite` system prompt 鐵則。
根因：模型把 `excerpt`（敘事原文）整段搬進輸出，而非提煉成知識條目。現有鐵則講了「不可發明」，沒講「不可照搬敘事散文」。新增鐵則：

> 輸出是**整理過的知識條目**，不是敘事轉貼。**禁止把本回合敘事片段的散文、對白、系統提示（如【系統公告】【副本載入完畢】）原文照抄進文件**；只能把片段中的事實**提煉**成條列式的設定描述。文件中不應出現「本回合」「沈奕這時」這類敘事時序語句。

protagonist 重寫（`callProtagonistRewrite`）共用同一條鐵則——它也吃敘事 excerpt，同樣要防照搬。

---

## 測試（TDD：每項先寫失敗測試再實作）

| 檔案 | 動作 |
|---|---|
| `schema.test.ts` | FastControl 移除 protagonist 欄位後仍解析；LoreSync 新增 `protagonist_points_delta` / `protagonist_changed` 解析（含預設值） |
| `lore-rewrite.test.ts`（擴充） | `callProtagonistRewrite`：積分區塊照抄、屬性整合不重複、不照搬敘事散文、繁體化等冪 |
| `turn-core.test.ts` | Layer 2 不再寫 protagonist.md（積分/updates 落地段移除） |
| `lore-sync.test.ts` | Layer 3 跑 applyPointsDelta → callProtagonistRewrite → 覆寫；delta=0 且 protagonist_changed=false 時完全不重寫 |
| `prompts.test.ts` | LORE_SYNC_FORMAT_BLOCK 含 id 直譯規則 + 反例；buildFastControl 不再含 protagonist_updates 說明 |
| `context.test.ts` | 移除 applyProtagonistUpdates 相關測試（若函式刪除）；applyPointsDelta 測試保留 |

## 驗證（end-to-end）

1. `npm run typecheck` + `npm test` 全綠（新測試先紅後綠）。
2. `npm run dev` 跑 ≥10 回合，人工確認：
   - `protagonist.md` 無重複條目（屬性/物品）。
   - 新技能/實體 id 與 name 直譯對應（無 `system_monitor` 式語意錯位）。
   - wiki / 角色檔無 raw 敘事散文 / 系統提示殘留。
   - 積分正確累計（延遲一回合反映面板，下一回合開始即正確）。
   - Layer 2 JSON 解析全程無 ERROR。
3. 驗證用 world/ 變更測完 `git checkout` 還原；既有壞檔不動。

## 不在本次範圍

- Bug 3（佈景過度建檔）——暫無可靠解，留待日後。
- 面板積分即時刷新（方案 B 的 SSE 二次 state 事件）——日後要「全即時」再單獨做。
- 既有壞 world/ 檔（劇情/開發分離，只修引擎）。
- 問題 15 的主敘事邏輯（倒數跳轉，35B 範疇）。
