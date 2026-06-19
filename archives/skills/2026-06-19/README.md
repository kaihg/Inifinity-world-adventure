# 已封存的遊玩類 skills（2026-06-19）

這些 skill 是「CLI + Claude Code 對話」時代的遊玩入口。它們的邏輯已由
`app/` 網頁引擎用程式碼重實作（回合收束協議、模式路由、真隨機骰、
自動推進、副本 enter/settle、世界重置），網頁引擎成為唯一遊玩路徑後封存。

保留純為歷史參考，**不再維護、不應再被當作遊玩入口**：

- `start-story/` → 引擎主空間回合（`engine/turn.ts` runMainSpaceTurn）
- `enter-dungeon/` → 引擎副本進入（`engine/dungeon.ts` enterDungeon + mode 路由）
- `settle-dungeon/` → 引擎副本結算（`mode_transition: settle_dungeon`）
- `roll-random/` → 伺服器端真隨機（`engine/roll.ts`）
- `init-world/` → 世界重置（尚未在引擎實作；如需重開，手動封存 `world/` 到
  `archives/<timestamp>/` 後重建，或日後在引擎補上重置流程）

> 對應的 `settle-on-merge.yml` GitHub Action 也屬於舊 PR/branch 副本流程，
> 新架構副本不切 branch，故該 workflow 已不會被遊玩觸發（保留為 legacy）。
