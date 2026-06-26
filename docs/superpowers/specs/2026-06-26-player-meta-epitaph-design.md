# 設計：玩家層 Meta 檔與主角墓誌銘

- 日期：2026-06-26
- 狀態：brainstorming 已確認，待使用者 review
- 範圍：先建立跨世界玩家層資料與主角墓誌銘前置結構；**不**實作多世界、帳號、traits 實際套用

## 1. 背景

目前引擎架構明確以 **單一 active world** 為前提：`world/` 是當前 lifetime 的唯一 canonical truth，`worldDir`、turn pipeline、server lock、recall index 也都綁定這一份狀態。若直接改成「同時多世界、由使用者選擇接續哪一個」，會牽動整個 runtime 的多租戶化，成本高且與目前產品階段不相稱。

但現有世界初始化又有另一個問題：每一輪如果都靠一套明顯的問答去側寫玩家，會變得乏味而制式；如果完全不保留跨輪痕跡，則每一輪主角又像是與前次遊玩完全斷裂。這需要一個位於 `world/` 之外、跨世界持續存在、但又不引入帳號系統或資料庫的輕量玩家層。

## 2. 本次要解的問題

本次設計只解三件事：

1. 在 **維持單一 active world** 前提下，新增一份 repo-level 的玩家層 canonical 資料。
2. 在主角結算時，為每一代主角留下可索引的短評資料，作為未來大 meta / traits 的前置資產。
3. 明確定義未來若要做玩家 traits，必須先補上的 **player decision provenance layer**。

## 3. 不做的事（Non-goals）

- 不做多世界並存與世界切換。
- 不做帳號、登入、多人隔離、資料庫。
- 不讓 `meta/` 回流影響 `world/init` 或新主角初始化。
- 不做 traits 分數、tag、開局 bonus/malus。
- 不做輪迴回顧 UI。
- 不把 `meta/` 納入 recall prompt 載入來源。
- 不直接從現有 `journal.md` 推論玩家人格。

## 4. 整體架構

新增一個 repo-level 的 `meta/` 目錄，與 `world/`、`archives/` 並列：

```text
meta/
  player.md
  epitaphs/
    <epitaph-id>.md
```

### 4.1 `world/` 與 `meta/` 的責任分界

- `world/`
  - 只描述**當前這一輪世界**的 canonical truth。
  - 副本結算只影響這一層。
  - 世界封存後由既有 `archives/<timestamp>/world/...` 保存。

- `meta/`
  - 描述**跨世界、跨主角代次**仍然持續存在的玩家層資料。
  - 不代表帳號，不支援多使用者切換。
  - 代表「這個 repo / 這個安裝實例的持續玩家痕跡」。
  - 不跟著 `world/` 重置或封存而被清空。

## 5. `meta/player.md` 設計

`meta/player.md` 是索引與摘要檔，不是全文倉庫。V1 只放低頻、穩定、可驗證的欄位。

建議結構：

```md
# 玩家檔案

- 已封存世界數：1
- 已結算主角代數：2
- 最後更新：2026-06-26

## 墓誌銘索引

| Epitaph ID | 世界參照 | 主角代數 | 主角姓名 | 結局類型 | 建立時間 |
|------------|----------|----------|----------|----------|----------|
| epi-20260626-001 | archives/2026-06-26T10-00-00 | 1 | 沈奕 | 死亡 | 2026-06-26 |
```

### 5.1 欄位語義

- `已封存世界數`
  - 對應 `world_history_count`
  - 每次 `/api/world/end` 成功封存世界時 `+1`

- `已結算主角代數`
  - 對應 `protagonist_generation_count`
  - 每次一代主角結束生命週期並寫出墓誌銘時 `+1`
  - 包含：
    - 主角死亡後換下一代
    - 主動封存當前主角後換下一代
    - 主角死亡後直接結束世界（此時世界數與代數都增加）

- `墓誌銘索引`
  - 只放摘要與 reference，不存墓誌銘全文
  - 用來支援未來的回顧、traits 提煉、角色更換與讀檔關聯

## 6. `meta/epitaphs/*.md` 設計

每一代主角對應一份短墓誌銘 / 主神評語，作為未來大 meta 之前的中介資產。

建議結構：

```md
# 主角墓誌銘

- Epitaph ID：epi-20260626-001
- 世界參照：archives/2026-06-26T10-00-00
- 主角代數：1
- 主角姓名：沈奕
- 結局類型：死亡
- 建立時間：2026-06-26

## 主神評語

……短評正文……
```

### 6.1 為什麼放在 `meta/epitaphs/`

- 它是跨世界玩家層資產，不應綁在 active `world/` 裡。
- 之後若要支援主角切換、讀檔寫入、跨輪 traits 提煉，這個位置最好索引。
- `recall` 目前只針對 `world/`，因此 `meta/` 不會被意外載入到劇情 prompt。

### 6.2 Reference 規則

每份墓誌銘都必須可追溯回對應世界或世界封存結果，因此內容與索引都需保存：

- `世界參照`
  - 若世界已封存：寫 `archives/<timestamp>`
  - 若主角結算時世界尚未封存：需先保存一個穩定的 world session reference，待世界封存時再補全或映射

V1 實作時可採其中一種策略：

1. 先為 active world 生成穩定 `world_session_id`，之後世界封存再對應到 archive path
2. 先允許墓誌銘 reference 指向 active world session，世界封存時補寫 archive reference

本設計要求的是：**reference 必須穩定、可追溯、不可只靠檔名猜測。**

## 7. 事件與更新時機

### 7.1 主角結算事件

主角結算事件是這次設計的核心，與世界結算分開。

觸發時機：

- 主角永久死亡後，使用者選擇換下一代
- 使用者主動封存當前主角，進入下一代
- 主角死亡後，使用者選擇直接結束世界

處理流程：

1. 收集本代主角的結算材料
2. 生成一篇短墓誌銘 / 主神評語
3. 寫入 `meta/epitaphs/<epitaph-id>.md`
4. 更新 `meta/player.md`
5. 再進入換代或世界封存後續流程

效果：

- `已結算主角代數 +1`
- 新增一筆墓誌銘索引

### 7.2 世界結算事件

觸發時機：

- `/api/world/end`

效果：

- 既有世界封存流程照舊
- `已封存世界數 +1`

若這次是「主角死亡後直接結束世界」：

- 先完成主角墓誌銘
- 再封存世界
- 因此同時增加：
  - `已結算主角代數`
  - `已封存世界數`

## 8. 為什麼現在不做 traits

本次討論確認：現有 `journal.md` 是完整敘事，不可靠地區分：

- 使用者明確輸入的決策
- LLM 補完或延伸出的主角動作
- NPC / 環境 / 系統敘事

在這個前提下，若直接讓 LLM 從 `journal.md` 推論玩家 traits，結果會飄且不可驗證。因此 traits 不應在 V1 啟用。

V1 的正確策略是：

1. 先把主角墓誌銘留下來
2. 等 decision provenance 到位後，再從「決策記錄 + 墓誌銘」提煉長期 traits

## 9. `player decision provenance layer` 前置要求

若未來要讓墓誌銘真正準確反映「玩家如何扮演這一代主角」，或進一步啟用 traits，必須先補一層 player decision provenance。

### 9.1 必須解的最小問題

至少要能記錄：

- 本回合使用者原始輸入
- 對應的主角代數
- turn id / 時間戳
- 這筆記錄屬於「使用者明確決策」

本次已確認：

- 不再考慮 auto-advance 分流，因為該功能已另開 feature 準備移除

因此未來 provenance layer 只需清楚區分：

- **玩家明確輸入**
- **非玩家輸入導致的敘事內容**

### 9.2 與本設計的關係

本 spec 不直接設計 provenance 的具體檔案格式與寫入實作，但把它定義為：

- 墓誌銘品質提升的必要前置
- traits 啟用的硬前置條件

也就是說，未來要做下列功能時，不可跳過這一層：

- 依玩家傾向生成主神評語
- 從歷代主角提煉長期 traits
- 用 traits 反向影響新世界或新角色初始化

## 10. 對現有系統的影響

### 10.1 需要新增的能力

- repo-level `meta/` 檔案管理
- 主角結算時的墓誌銘生成流程
- `meta/player.md` 計數與索引維護
- 墓誌銘與 archive/session 的 reference 管理

### 10.2 不需要改動的核心假設

- `world/` 仍是唯一 active world canonical truth
- server 仍是單世界、單玩家實例
- `worldDir` 不變成多租戶
- recall 不讀 `meta/`

## 11. 測試與驗證

V1 的驗證重點不是 prompt 效果，而是資料邊界與關聯正確性。

### 11.1 資料正確性

- 主角換代時，正確新增一份 `meta/epitaphs/*.md`
- `meta/player.md` 的主角代數正確增加
- 主角死亡後直接結束世界時，世界數與代數都正確增加
- 索引可正確指向對應世界 reference

### 11.2 邊界正確性

- `world/` 與 `meta/` 責任不混淆
- `meta/` 不被 recall 載入
- 未補 provenance 前，不啟用 traits 判分

## 12. 後續路線

本設計是較大 meta progression 之前的前置作業。建議後續順序：

1. 實作 `meta/player.md` 與 `meta/epitaphs/`
2. 實作主角結算事件與墓誌銘生成
3. 補 `player decision provenance layer`
4. 之後再另寫新 spec，決定如何從墓誌銘 + provenance 提煉 traits
5. traits 穩定後，再考慮是否回流影響新世界 / 新主角初始化

這樣可以在不碰多世界、不碰帳號、不碰 DB 的前提下，先讓玩家層資料開始累積，而且不與未來擴充衝突。
