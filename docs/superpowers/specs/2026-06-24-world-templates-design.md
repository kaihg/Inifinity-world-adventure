# World Templates 設計文件

**日期**：2026-06-24  
**背景**：目前 `initWorld` 靠 prompt 描述讓 LLM 自由生成所有世界檔案，沒有骨架約束，段落格式每次可能不同，造成跨回合的劇情一致性風險。

---

## 目標

- **劇情一致性（B 類問題）**：確保同一世界的規則（道具品質系統、副本難度分級等）在每回合都有固定事實錨點，LLM 不會因段落埋得太深或格式不同而「忘掉」
- 不追求引擎 parse 穩定性（A 類問題）：道具品質系統等規則在各世界不同，無統一解析邏輯，不需要

---

## 核心方案：Template as Scaffold

### 原則

- `templates/` 只定義**骨架**：段落標題 + 一行說明，**不填值**
- 骨架決定「這份文件必須有哪些 `##` 段落」，但段落內的值由 LLM 在 init 時自由創作
- 有一個「## 世界特定設定」段作為自由延伸區，每個世界可加自己的規則
- `world/` 內的檔案是骨架 + 填值後的完整結果，段落標題不可在遊玩中途改動

### initWorld 流程（修改後）

```
1. 讀 templates/setting.md（骨架）
2. 把骨架貼進 system prompt：
   「請依以下骨架結構填入此世界的具體規則，段落標題不可改動，
     每段自由發揮內容，但必須在本世界全程一致」
3. LLM 輸出 → world/setting.md（已填值，段落齊全）
```

`protagonist.md`、`dungeon.md` 同理。場景不在 init 時批量生成，劇情推進時按需生成。

---

## 目錄結構

```
templates/
  setting.md        # 世界設定骨架
  protagonist.md    # 主角檔案骨架
  dungeon.md        # 副本/地城骨架
  scene.md          # 場景骨架（輕量）
  npc.md            # NPC 檔案骨架

world/
  setting.md        # 填值後的世界規則（此世界唯一）
  gm-notes.md       # 隱藏真相（不受 template 約束，GM 自由生成）
  journal.md        # 主空間流水帳（append-only）
  now.md            # 當前快照（引擎每回合覆寫）
  characters/
    index.md
    protagonist.md  # 填值後的主角檔案
    <npc-id>.md     # 填值後的 NPC 檔案
  scenes/
    <scene-id>.md   # 主空間固定場景（填值後）
  dungeons/
    <id>/
      wiki.md
      secrets.md
      scenes/
        <scene-id>.md   # 副本場景（填值後，副本結束一起封存）
      runs/
        <run-id>.md
```

---

## 各 Template 用途（待詳細設計）

| 檔案 | 用途 | 生成時機 | 對應 Task |
|------|------|----------|-----------|
| `templates/setting.md` | 世界規則骨架（道具系統、副本分級、主神規則等） | initWorld | #8 |
| `templates/protagonist.md` | 主角檔案骨架（屬性、物品、buff 等） | initWorld / replaceProtagonist | #9 |
| `templates/dungeon.md` | 副本骨架（難度、主題、機關等） | 首次進入副本時 | #10 |
| `templates/scene.md` | 場景骨架（外觀、氛圍、已知資訊） | 劇情按需生成 | #11 |
| `templates/npc.md` | NPC 骨架（外觀、性格、動機、關係） | 劇情按需生成 | #12 |

---

## 場景注入策略（已討論）

場景檔案**不在固定 context 載入清單**，而是靠 recall 語意檢索按需召回：

- 玩家動作提及某場景 → recall 以此為 query → 對應 scene 片段注入 prompt
- 優點：不會因為硬注入當前場景而錨定 LLM、阻礙場景轉換；回到舊場景時也能自然召回
- 已知限制：recall 有漏召風險，接受此限制，留待實戰數據再補強

主空間場景（`world/scenes/`）與副本場景（`world/dungeons/<id>/scenes/`）並存，生命週期不同：副本場景隨副本封存，主空間場景貫穿整個 lifetime。

---

## 尚未設計（各 Template 細節）

各 template 的具體骨架內容、以及引擎需要的對應修改，分別在 Task #8–#12 中逐一討論。
