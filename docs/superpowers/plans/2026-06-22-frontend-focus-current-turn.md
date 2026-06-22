# 前端專注當前回合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓前端劇情區專注於當前回合 — 新回合開始即清空舊劇情，streaming 期間畫面不再逐 token 向下跳動。

**Architecture:** 改動集中在單一檔案 `app/web/src/App.tsx`。送出行動時清空 `story` state；移除以 `[story]` 為依賴的逐 token `scrollIntoView` effect，改為在清空後做一次性捲動到劇情卡頂端。

**Tech Stack:** React + TypeScript（Vite），SSE 串流。

## Global Constraints

- 引擎/劇情面（`world/`、`app/src/`）不在本次範圍 — 只改前端 `app/web/`。
- 純 UI 互動行為，前端目前無測試基建，採手動驗證。
- 維持既有 immutable state 更新風格（`setStory((s) => ...)`）。

---

### Task 1: 清空舊劇情並停止逐 token 跳動

**Files:**
- Modify: `app/web/src/App.tsx`

**Interfaces:**
- Consumes: 既有 `streamTurn(text, onEvent)`、`TurnEvent` 型別、`story`/`setStory` state、`storyEndRef`、`story-card` DOM 結構（`App.tsx:181-189`）。
- Produces: 無對外新介面 — 純內部行為調整。

本任務的四個改動互相耦合（同屬「專注單回合」一個行為），一起改、一次驗證、一次 commit。

- [ ] **Step 1: 移除逐 token 捲動的 useEffect**

刪除 `App.tsx:58-60` 這段：

```tsx
  useEffect(() => {
    storyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [story]);
```

- [ ] **Step 2: 在 send() 開頭清空 story 並做一次性捲動到頂**

把 `send()` 開頭（`App.tsx:62-68`）的：

```tsx
  async function send(action: string) {
    const text = action.trim();
    if (!text || busy) return;
    setBusy(true);
    setSuggested([]);
    setInput("");
    let firstToken = true;
```

改為（新增 `setStory("")` 與一次性捲動，移除不再需要的 `firstToken`）：

```tsx
  async function send(action: string) {
    const text = action.trim();
    if (!text || busy) return;
    setBusy(true);
    setStory("");
    setSuggested([]);
    setInput("");
    // 新回合：把劇情卡捲到可視區頂端，streaming 期間不再自動捲動
    storyEndRef.current?.parentElement?.scrollIntoView({ behavior: "smooth", block: "start" });
```

> 註：`storyEndRef` 掛在 story-card 內最後的空 `<div>`（`App.tsx:188`），其 `parentElement` 即 `story-card`。捲到卡片頂端讓新回合從頭閱讀。

- [ ] **Step 3: 簡化 delta 事件處理（移除 firstToken 前綴）**

把 `delta` case（`App.tsx:76-80`）：

```tsx
          case "delta":
            setStory((s) =>
              firstToken ? ((firstToken = false), s + "\n\n" + ev.text) : s + ev.text,
            );
            break;
```

改為（story 已清空，直接累加）：

```tsx
          case "delta":
            setStory((s) => s + ev.text);
            break;
```

- [ ] **Step 4: 移除其他事件對 firstToken 的依賴**

`auto-advance` case（`App.tsx:81-84`）目前含 `firstToken = false;`，移除該行（`firstToken` 已不存在）。改為：

```tsx
          case "auto-advance":
            setStory((s) => s + "\n\n—— 系統自動推進 ——\n\n");
            break;
```

其餘 `transition`／`warning`／`error`／`done` case 不變（它們本就不引用 `firstToken`）。確認改完後檔案中已無任何 `firstToken` 參照。

- [ ] **Step 5: 型別檢查 / build 驗證**

Run: `cd app && npm run build`
Expected: build 成功，無 TypeScript 錯誤（特別是無「`firstToken` is not defined」或 unused variable）。

- [ ] **Step 6: 手動驗證**

Run: `cd app && npm run dev`，開 http://localhost:5174

驗證：
1. 送出一個行動 → 等 streaming 完成 → 再送出第二個 → 第二回合開始時舊劇情立即消失，只顯示新回合。
2. streaming 進行中 → 畫面不再逐 token 向下跳動。
3. 若可觸發自動推進／進出副本 → 同一回合內「—— 系統自動推進 ——」「【進入副本…】」等分隔標記仍正常顯示。
4. 重整頁面 / 切到背景再回來 → 顯示最近一回合 narrative，行為不變。

> 若無法連到 LLM 後端做完整 streaming 驗證，至少確認 1（送出清空）、4（重整載入）兩項，並於 commit message 註明 streaming 互動待實機驗證。

- [ ] **Step 7: Commit**

```bash
git add app/web/src/App.tsx
git commit -m "fix(web): 新回合清空舊劇情並停止 streaming 逐 token 跳動"
```

---

## Self-Review

**1. Spec coverage:**
- 改動 1（新回合清空舊劇情）→ Task 1 Step 2、3、4。
- 改動 2（停止逐 token 跳動）→ Task 1 Step 1、2。
- 改動 3（背景喚醒/初始載入相容，不需改動）→ 已確認 `refresh()`／癒合輪詢皆整段覆寫 story，未被本計畫觸及，行為不變。
- 不做（歷史劇情載入）→ 未列入任務。✓ 全部覆蓋。

**2. Placeholder scan:** 無 TBD/TODO；每個改碼步驟皆附完整 before/after 程式碼。✓

**3. Type consistency:** 未新增型別或函式簽章；`setStory`/`storyEndRef`/`TurnEvent` 皆沿用既有定義。移除 `firstToken` 後 Step 4 已要求確認無殘留參照。✓
