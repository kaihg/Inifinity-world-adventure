# World Init / End / 主角換代 接口設計

## 背景

目前引擎（`app/src/`）只服務「已經存在一個世界」的情境：`/api/state` 讀、`/api/turn` 推進回合，世界的誕生與結束完全沒有引擎入口。`world/` 從零開始的生成、結算後的重置/封存，過去靠 `archives/skills/2026-06-19/init-world/SKILL.md`（已封存）這種 Claude Code 對話式 skill 手動完成。CLAUDE.md 現在明確寫「世界重置目前沒有引擎入口……如需重開，手動把 `world/` 封存到 `archives/<timestamp>/` 再重建」。

本設計補上三個引擎原生接口：**世界初始化（Init）**、**世界封存（End）**、**主角死亡後換代（同世界新主角）**，並讓前端在「世界尚未初始化」與「主角剛死亡」這兩個狀態下，能引導玩家走完對應流程，而不需要再靠人工編輯 `world/`。

## 目標

1. `GET /api/world/status`：讓前端判斷要不要顯示初始化精靈頁。
2. `POST /api/world/init`：全自動單次表單，生成一個全新世界（玩家可見設定 + 自主生成的隱藏設定 + 主角起始狀態），對齊舊 `init-world` skill 的步驟，但拿掉所有需要多輪對話確認的部分。
3. `POST /api/world/end`：封存目前世界（含 LLM 生成的結局摘要），把 `world/` 重置回「尚未初始化」佔位狀態。
4. `POST /api/world/protagonist`：**只能由「主角永久死亡」事件觸發**，不對外提供獨立按鈕。保留 `setting.md`/`gm-notes.md`/`dungeons/*/wiki.md`，只換主角與主空間時間線。
5. Schema 新增 `protagonist_permanent_death` 欄位，讓 Layer 2 能明確區分「一般死亡走新手保護結算」與「故事真正畫下終點的死亡」。
6. `ProtagonistSeed` 型別預留 `build` 欄位，供未來獨立的「天賦/屬性點數分配」設定頁接入，現在完全不實作內容。

## 不變的部分

- 既有回合循環（`runTurnCore`/`runTurnLoop`/Layer 2/Layer 3 拆分、`pendingLoreSync` 接力機制）完全不動。
- `now.md` 七欄定義、`journal.md`/`runs/*.md` 的 raw append 模型、`wiki.md`/`secrets.md` 的揭露式知識分離，沿用既有 `lore.ts`/`now.ts`/`dungeon.ts`。
- `commitWorld`（`git/commit.ts`）的呼叫方式不變：本設計新增的三個 world-level 操作各自呼叫一次 `commitWorld`，比照 `app.ts` 現有 `makeCommit` 的 debug 模式跳過邏輯（`config.debug` 時不真的 commit）。
- 不引入第二個主角/第二個世界同時存在的概念：任何時刻 `world/` 仍只代表一條進行中的故事線，三個新操作都是「對這條唯一時間線」做轉移，不是分支。

## 架構變更

### 1. World 狀態判斷

`world/setting.md` 維持一個機器可判斷的「尚未初始化」佔位 marker（沿用舊 skill 的判斷依據：setting.md 內容是否仍是初始佔位文字）。新增 `app/src/engine/world-status.ts`：

```typescript
export async function isWorldInitialized(worldDir: string): Promise<boolean>
```

`GET /api/world/status` 直接呼叫，回傳 `{ initialized: boolean }`。

### 2. Archive 路徑格式

新增 `app/src/engine/archive.ts`：

```typescript
/** UTC 日期時間格式，可排序、人類可讀：2026-06-23_14-30-00 */
export function archiveTimestamp(now: Date = new Date()): string

/** 把 worldDir 整個目錄複製到 archives/<archiveTimestamp()>/world/，回傳封存路徑 */
export async function archiveWorld(repoRoot: string, worldDir: string): Promise<string>

/** 只把指定的相對路徑清單（例如主角換代時的 protagonist.md/index.md/journal.md）複製到 archives/<archiveTimestamp()>/world/ */
export async function archiveWorldFiles(repoRoot: string, worldDir: string, relativePaths: string[]): Promise<string>
```

**格式變更**：原規劃用緊湊 `YYYYMMDD-HHMMSS`，改成可讀的 `YYYY-MM-DD_HH-mm-ss`（仍是 UTC、仍可字串排序）。`/api/world/end` 與 `/api/world/protagonist` 都呼叫這裡，不各自重複實作時間格式化。

### 3. `POST /api/world/init`

請求 body：

```typescript
interface WorldInitRequest {
  preferences?: {
    difficulty?: string;      // 難度（前端單選：簡單/普通/困難/地獄）
    godPersona?: string;      // 主神表面性格（前端單選；內在動機由 gm-notes 另生）
    protectionRule?: string;  // 新手保護（前端單選：寬鬆/標準/嚴苛/無保護）
  };
  protagonistSeed?: ProtagonistSeed; // ProtagonistSeed 內 name/freeform 皆 optional
}
```

所有欄位皆為 optional，**不做後端預設值補齊或字串驗證**：未填的欄位在生成 prompt 時標注「使用者未指定，由你自由發揮」，交給 LLM 在生成 `setting.md`/`protagonist.md` 時一併決定（理由：單機單玩家場景，輸入是給 LLM 發揮的素材而非需要防禦的外部資料，加驗證只會限制創作彈性）。前端三個偏好以單選 chip 呈現，並提供「隨機」（送出當下抽一個具體值）與「不選」（送空字串＝交給 LLM）兩種選擇；`difficulty` 取代原本的自由文字 `tone`/`horrorIntensity`（基調移除、由 LLM 自行發揮）。

只在 `isWorldInitialized() === false` 時允許呼叫（已初始化時回 409）。世界級生成一律用 `app.ts` 既有的主 `client`（`makeClient`/`createOpenAiClient` 的預設那一份），不重用 `characterClient`/`controlClient`/`loreClient`——那三個是回合內分工用的，世界初始化是一次性、低頻操作，不值得為它新開一個 config 區塊。流程（單次、無草稿預覽步驟）：

1. 用主 `client` 生成 `setting.md` 玩家可見內容。
2. 緊接著（同一次請求內、不回傳給前端）生成 `gm-notes.md` 隱藏內容——prompt 只讀步驟 1 的 `setting.md` 結果，不讀使用者原始 `preferences` 逐字稿，避免隱藏設定意外洩漏成顯性文字的複製貼上。
3. 用 `buildProtagonistPrompt(protagonistSeed)`（見第 6 節）生成 `protagonist.md`。
4. 重建 `characters/index.md`（只留主角一行）、`journal.md`（清空+起始時間戳）、`now.md`（覆寫起始局勢）、清空 `dungeons/`。
5. `commitWorld({ message: "重置世界、生成新設定" })`（比照 CLAUDE.md「commit message 只寫事實，不寫劇透內容」的既有約定；這裡的 message 是引擎自己給的固定字串，不是 LLM 生成內容，不會意外帶出 gm-notes 文字）。
6. 若 `config.recallEnabled`，刪除整個 `app/.recall-index/` 目錄（見第 7 節「Recall 索引處理」），不主動重建，下次需要時自然 lazy 重建。

四個新路由（`init`/`end`/`protagonist`/`status`）的寫檔/commit 步驟都比照 `app.ts` 現有 `makeCommit` 的 `config.debug` 行為：debug 模式下跳過實際 `commitWorld` 呼叫（只記 log），但檔案本身仍正常寫入，方便本機測試流程不弄髒 git 歷史。

回傳新的 `GameState`（沿用 `loadState`）。

### 4. `POST /api/world/end`

請求 body：`{ confirmText: string }`，伺服器驗證 `confirmText === "封存"`（精確字串比對，不接受變體），不符直接 400，避免前端誤觸。

**前置檢查**：`world/.pending-death` 存在時直接回 409（訊息提示「請先完成主角換代或結束世界的抉擇」）。理由：避免玩家在死亡抉擇 modal 顯示期間繞過 `/api/world/protagonist` 直接呼叫這支通用封存 API，確保所有「死亡後結束世界」的路徑都走同一套（含清除 `world/.pending-death`）的邏輯。

流程：

1. 讀 `journal.md`/`now.md`/`protagonist.md`，呼叫 LLM 生成一篇「故事終章摘要」。
2. `archiveWorld(repoRoot, worldDir)` → 取得 `archives/<datetime>/`，把摘要寫成 `archives/<datetime>/summary.md`。
3. 把 `world/` 重置回初始化前的佔位狀態（`setting.md` 寫回「尚未初始化」、`gm-notes.md` 寫回「尚未生成」、`protagonist.md`/`characters/index.md`/`journal.md`/`now.md` 清空、`dungeons/` 清空）。
4. `commitWorld({ message: "封存世界" })`。
5. 若 `config.recallEnabled`，刪除整個 `app/.recall-index/` 目錄（見第 7 節）。

摘要生成的 prompt 只能讀 `setting.md`（玩家可見）+ `journal.md`/`now.md`/`protagonist.md`（已發生的劇情事實），**不可讀 `gm-notes.md`**，避免結局摘要把尚未在敘事中揭露的隱藏真相寫進 `summary.md`（`archives/` 雖然是封存區，但仍是 repo 內可被翻閱的檔案，不是真正的「劇透保險箱」）。

回傳 `{ archivedTo: string }`。

### 5. 主角永久死亡 → 換代流程

#### 5a. Schema 新增欄位（`schema.ts`）

`FastControlSchema` 新增：

```typescript
protagonist_permanent_death: z.boolean().default(false),
```

語意：只有當 `mode_transition === "settle_dungeon"` **且**模型依 `setting.md` 新手保護規則判定保護已耗盡、角色真正永久死亡時才為 `true`。一般死亡（新手保護生效中）走既有結算路徑，這個欄位維持 `false`，行為完全不變。

#### 5b. Turn engine 行為（`app/src/engine/turn/turn-core.ts`）

`protagonist_permanent_death === true` 時：

1. 強制 `awaiting_user_input = true`（即使模型回 `false` 也覆寫，避免自動推進把死亡後續劇情演下去）；實作位置在 `turn-core.ts` 組 `done` event 之前，依 `control?.protagonist_permanent_death` 覆寫該欄位，不依賴模型自己回報正確（目前 `done` 組裝是 `control?.awaiting_user_input ?? true`，這裡要再加一層覆寫條件）。
2. 寫入 pending-death 標記檔 `world/.pending-death`（內容：ISO 時間戳即可，純粹當 sentinel）。**這個檔案必須加進 repo 根目錄 `.gitignore`**：`commitWorld`（`git/commit.ts`）目前是 `git.add(["world"])` 整個目錄下去，標記檔若不排除會被一起 commit 進歷史，違反「`world/` 只放故事正文、不放引擎內部狀態」的慣例。`.gitignore` 生效後 `git add` 自然跳過它，不需要在 `commitWorld` 裡額外處理。
3. `now.md` 的「主角下一步打算」欄覆寫成固定文字：「等待抉擇：保留世界換主角 / 結束世界」。
4. `done` event 新增欄位 `protagonistDied: boolean`。**這個欄位目前在 `TurnEvent`（`turn/types.ts`）與前端鏡像型別（`app/web/src/api.ts` 的 `TurnEvent`）的 `done` 分支都還不存在，兩邊都要加**。

#### 5c. `/api/turn` 的前置檢查

實作位置在 `app/src/server/app.ts` 的 `/api/turn` route handler 內，讀完 `req.body` 之後、呼叫 `runTurnLoop` 之前：先檢查 `world/.pending-death`（一次 `existsSync`，成本可忽略）是否存在；存在時直接寫一個 `{ type: "error", message: "主角已死亡，請先完成換代或封存抉擇" }` SSE 事件並結束連線，不呼叫 `runTurnLoop`、不消耗骰池、不呼叫任何 LLM。`runTurnLoop`/`runTurnCore` 本身不需要改（檢查純粹是路由層的前置閘門）。這是後端側的硬擋，前端的抉擇 modal 是第一道（也是主要）防線。

#### 5d. `POST /api/world/protagonist`

請求 body：`{ choice: "keep-world" | "end-world", protagonistSeed?: ProtagonistSeed }`（`end-world` 時不需要 `protagonistSeed`，直接內部轉呼叫等同 `/api/world/end` 的邏輯，但 `confirmText` 免填——因為已經是死亡流程內的明確選擇，不需要再打字確認一次）。

只在 `world/.pending-death` 存在時允許呼叫（不存在回 409，防止脫離死亡情境被誤呼叫或濫用）。

`choice === "keep-world"` 流程：

1. 讀 `journal.md`/`protagonist.md`（同樣不讀 `gm-notes.md`），生成一篇簡短「前任主角退場摘要」。
2. `archiveWorldFiles(repoRoot, worldDir, ["characters/protagonist.md", "characters/index.md", "journal.md", "now.md"])`，退場摘要寫成同一批封存目錄底下**獨立的** `archives/<datetime>/summary.md`（這是新建立的 `archives/<datetime>/` 目錄，不會跟 `/api/world/end` 的封存目錄混在一起，因為兩者是不同時間點、各自呼叫一次 `archiveTimestamp()`）。`now.md` 一併封存：保留死亡那一刻的「當前局勢」完整快照，不只靠 `journal.md` 的 raw 記錄回推。
3. 用 `buildProtagonistPrompt(protagonistSeed)` 重新生成 `protagonist.md`；`characters/index.md` 只留新主角一行；`journal.md` 清空 + 新起始時間戳；`now.md` 覆寫新主角起始局勢（場景描述可引用既有 `setting.md`/`gm-notes.md` 的世界觀，但本設計不規定具體 prompt 內容，留給實作時的 prompt engineering）。
4. **不**動 `setting.md`/`gm-notes.md`/`dungeons/*/wiki.md`/`dungeons/*/secrets.md`。
5. 刪除 `world/.pending-death`。
6. `commitWorld({ message: "主角換代" })`。
7. 若 `config.recallEnabled`，刪除整個 `app/.recall-index/` 目錄（見第 7 節）。

`choice === "end-world"` 流程：等同 `/api/world/end`（內部直接呼叫同一段邏輯），但**不要求 `confirmText`**——這個選擇已經是死亡抉擇 modal 裡的明確按鈕操作（modal 本身有按鈕二次確認，見前端章節），不需要再打字輸入「封存」；額外多刪除 `world/.pending-death`。

### 6. `ProtagonistSeed`：預留天賦/屬性點數系統的擴充位

```typescript
export interface ProtagonistSeed {
  name?: string;
  freeform?: string; // 出身、性格、目標等自由描述（合併原 origin/freeform 兩欄）
}

// 現在不實作任何欄位內容，只佔住型別與函式簽章位置；
// 未來若做獨立的「隱藏分數 → 天賦/屬性選擇」設定頁，
// 只需要讓那個頁面填好 build 後丟進現有的 /api/world/init、/api/world/protagonist，
// 不必改這兩支路由的形狀。
export interface ProtagonistBuild {
  hiddenScore?: number;
  talents?: string[];
  attributeAllocations?: Record<string, number>;
}
```

> 註：經與使用者確認，`ProtagonistSeed.build?: ProtagonistBuild` 現階段**不會被任何呼叫端填值**，純粹是型別卡位。

`app/src/engine/protagonist-seed.ts` 新增：

```typescript
export function buildProtagonistPrompt(seed: ProtagonistSeed): string
```

`/api/world/init` 與 `/api/world/protagonist` 都呼叫這個共用函式組生成 prompt，現在函式內部只用到 `name`/`origin`/`freeform`；未來要支援 `build` 時，只需要在這個函式內加一段「若 `build` 存在則把天賦/屬性也寫進 prompt」的分支，呼叫端完全不用改。

### 7. Recall 索引處理

`app/src/engine/turn/turn-core.ts` 每回合呼叫 `reindexTouchedFiles` 對 `.recall-index/` 做增量更新；但 `init`/`end`/`protagonist` 三個操作是直接整批重寫/清空 `world/`，不是走 turn 流程，增量更新機制不適用，也不該套用——索引若不清，封存後的舊世界向量會殘留，下個新世界開局時可能撈到上一世界的片段污染 prompt。

做法：三個操作各自完成檔案寫入與 `commitWorld` 之後，若 `config.recallEnabled`，刪除整個 `app/.recall-index/` 目錄（沿用 CLAUDE.md 既有定位：這是 derived cache，可隨時刪除重建）。不主動觸發重建，下次有請求需要 recall 時讓既有的 lazy 初始化邏輯自然重建。三個路由共用同一個小函式（例如 `app/src/recall/clear-index.ts` 的 `clearRecallIndex(config)`），避免三處各自重複寫刪除目錄的邏輯。

## 前端變更（`app/web/src/`）

### 開機判斷

`App.tsx` 啟動時先打 `/api/world/status`：

- `initialized === false` → 渲染 `<WorldSetupWizard onDone={...}>`，不渲染現有的劇情主畫面。
- `initialized === true` → 照舊渲染 `<App>` 主畫面。

### `WorldSetupWizard`（新檔案，例如 `app/web/web/src/WorldSetupWizard.tsx`）

單一表單（無草稿預覽步驟）：難度、主神性格、新手保護（三者皆單選 chip，含「隨機」、可不選）＋ 主角姓名 ＋ 主角描述（合併出身/自由描述的單一 textarea）→ 送出 `POST /api/world/init` → loading 狀態（提示文案可比照現有 `COMPUTING_HINT` 的風格）→ 成功後呼叫傳入的 `onDone(state)`，由 `App.tsx` 切回主畫面並用回傳的 `GameState` 初始化。「基調」欄移除（由 LLM 自行發揮）；單選的 label 用「主神性格」而非「表面性格」，避免一開始就向玩家暗示有第二層人格（後端仍維持表面/內在分離）。

### header 操作列：封存世界

「封存世界」是**操作行為**而非遊戲資訊，因此不放進顯示遊戲狀態的側邊欄/`StatusDrawer`（那裡只鏡像狀態與 NPC 面板），改放在 header 右側的操作群（`.header-actions`，所有視窗寬度皆顯示——桌面只隱藏其中「開面板」鈕，封存鈕保留；否則桌面玩家無法觸及）。封存鈕以 danger 色的 icon 按鈕呈現（`aria-label`/`title`＝「結束並封存世界」），**不**包含換主角按鈕（換主角不對外開放）。

1. 點擊 → 置中二次確認對話框（`EndWorldModal`，置中 `.modal-card`，非靠右抽屜；按鈕用長方形 `.btn`，非圓形 send 鈕），比照死亡抉擇 modal 的 end-world：只用「取消 / 確定封存」兩個按鈕確認，**不需要打字輸入「封存」**。後端 `/api/world/end` 仍要求 `confirmText === "封存"` 作為防裸 API 誤觸的閘，由前端按「確定封存」時程式帶入該字串。
2. 呼叫 `POST /api/world/end`。
3. 成功後整頁狀態切回「未初始化」，等同重新打一次 `/api/world/status` 並渲染 `WorldSetupWizard`。

死亡抉擇 modal 顯示期間（即 `protagonistDied` 狀態為 true、composer 停用的同一段時間），這個按鈕也同步停用（disabled），避免使用者點擊後從後端拿到 409 才知道要先走死亡抉擇流程。

### 死亡抉擇 modal

`App.tsx` 的 `streamTurn` 事件處理在 `done` 事件裡新增判斷：`ev.protagonistDied === true` 時：

- **不**顯示 `suggested.length > 0` 的建議行動 chips（即使 `ev.suggestedActions` 非空也忽略）。
- 顯示阻斷式 `<DeathChoiceModal>`：
  - 「保留這個世界，新主角接續」→ 展開小表單（新主角姓名/出身/自由描述）→ `POST /api/world/protagonist` body `{ choice: "keep-world", protagonistSeed }` → 成功後關閉 modal、`refresh()` 拉新狀態，留在主畫面。
  - 「結束這個世界」→ 按鈕二次確認（「確定要結束這個世界嗎？」+ 取消/確定結束兩個按鈕，**不需要打字輸入**——已經是死亡流程內的明確選擇）→ `POST /api/world/protagonist` body `{ choice: "end-world" }` → 成功後切回 `WorldSetupWizard`。
- modal 顯示期間 composer（輸入框/送出按鈕）與 `StatusDrawer` 的封存按鈕都停用，避免使用者繞過抉擇直接打字或另開一條路徑封存（後端 `world/.pending-death` 檢查是最後一道防線，前端先擋一次體驗更好）。

### `api.ts` 新增

```typescript
export async function fetchWorldStatus(): Promise<{ initialized: boolean }>
export async function initWorld(body: WorldInitRequest): Promise<GameState>
export async function endWorld(confirmText: string): Promise<{ archivedTo: string }>
export async function resolveProtagonistDeath(
  body: { choice: "keep-world"; protagonistSeed: ProtagonistSeed } | { choice: "end-world" }
): Promise<GameState | { archivedTo: string }>
```

`TurnEvent` 的 `done` 分支型別新增 `protagonistDied: boolean`。

**順手修正既有型別漂移**：目前後端 `app/src/engine/turn/types.ts` 的 `TurnEvent.done` 已有 `transitionDungeonId`/`transitionDungeonGoal`，但前端 `app/web/src/api.ts` 的鏡像型別漏了這兩個欄位（與本設計無關的既有缺漏）。既然這次本來就要同時改這兩個檔案加 `protagonistDied`，順便把這兩個欄位也補上，讓前後端型別一致。

## 錯誤處理與降級

- `/api/world/init`：已初始化時呼叫 → 409，不做任何檔案操作。LLM 呼叫失敗（setting/gm-notes/protagonist 任一步）→ 整個請求視為失敗，**不** commit、**不**留下半套狀態（生成過程全部寫到記憶體變數，最後才一次性寫檔+commit，避免半初始化的世界）。
- `/api/world/end`：`world/.pending-death` 存在 → 409（先走死亡抉擇流程）。`confirmText` 不符 → 400。摘要生成 LLM 失敗 → 記 warning，`summary.md` 內容改寫固定文字「（摘要生成失敗）」，**不**因此中止封存流程（封存本身比摘要更重要，不能因為摘要失敗就卡住）。
- `/api/world/protagonist`：`world/.pending-death` 不存在 → 409。退場摘要生成失敗 → 同上，固定文字降級，不中止換代流程。
- `/api/turn`：偵測到 `world/.pending-death` 存在 → 直接回 `error` event，不呼叫任何 LLM、不消耗骰池。

## 測試策略

- `world-status.test.ts`：`isWorldInitialized` 對「佔位 setting.md」與「正常 setting.md」兩種輸入的判斷。
- `archive.test.ts`：`archiveTimestamp` 格式驗證；`archiveWorld`/`archiveWorldFiles` 對暫存目錄的搬移行為（含目的地目錄不存在時自動建立)。
- `schema.test.ts`：新增 `protagonist_permanent_death` 預設值與顯式 `true`/`false` 的解析測試。
- `clear-index.test.ts`：`clearRecallIndex` 在 `.recall-index/` 存在/不存在、`config.recallEnabled` 為 true/false 時的行為（不存在或停用時應為 no-op，不丟錯）。
- `protagonist-seed.test.ts`：`buildProtagonistPrompt` 對 `name`/`origin`/`freeform` 全部填值、以及全部留空（驗證 prompt 含「由你自由發揮」提示文字）兩種輸入的純函式測試（不需要測 `build`，因為現在保證永遠是 `undefined`）。
- `app.test.ts`：
  - `/api/world/status` 在 fake 已/未初始化 world 目錄下的回應。
  - `/api/world/init` 成功路徑（fake LLM client，含 `preferences`/`protagonistSeed` 全部留空時仍能成功生成）與已初始化時的 409；成功路徑驗證 `app/.recall-index/` 被刪除（fake 一個既有的 `.recall-index/` 目錄）。
  - `/api/world/end` 的 `confirmText` 校驗、`world/.pending-death` 存在時的 409、成功封存後 `setting.md` 回到佔位狀態，以及 `.recall-index/` 被刪除。
  - `/api/world/protagonist`：無 `world/.pending-death` 時 409；有標記時 `keep-world`（驗證 archive 清單含 `now.md`）/`end-world`（驗證**不需要** `confirmText` 也能成功）兩種選擇路徑。
  - `/api/turn`：有 `world/.pending-death` 時直接回 error，不觸發 fake client 的 `streamChat`。
- `turn-core.test.ts`（或其拆分後對應檔案）：`protagonist_permanent_death: true` 時驗證強制 `awaiting_user_input=true`、寫入標記檔、`now.md` 下一步欄被覆寫、`done` event 帶 `protagonistDied: true`。

## 範圍外

- 不實作「天賦/屬性點數分配」的獨立設定頁與其計算邏輯，只在 `ProtagonistSeed` 型別與 `buildProtagonistPrompt` 簽章上保留擴充位。
- 不支援世界初始化的多輪對話式草稿確認（已決議全自動單表單）。
- 不開放「主角換代」作為玩家可隨時手動觸發的功能；只能由引擎判定的 `protagonist_permanent_death` 事件觸發。
- 不引入第二個並行世界/主角；任何時刻 `world/` 只代表一條進行中的故事線。
- 不處理 `archives/` 目錄本身的清理/容量管理（沿用現有「只讀快照、人工維護」慣例）。
