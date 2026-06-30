# LLM 呼叫批次化設計（Layer 1 預載 / Layer 2-3 batch）

**日期：** 2026-06-30  
**問題：** Layer 1 主腦串流與前端 SSE 連線生命週期綁在一起，切換分頁或關閉瀏覽器時 `reply.raw.write()` 可能拋錯，導致回合被標記為失敗；Layer 2/3 雖然不影響 UX，但用串流累積 `raw` 的寫法不必要地繁瑣，且無法使用提供者的 JSON 強制約束。

---

## 目標

1. **Layer 1**：LLM 呼叫改為 batch，回合處理與 SSE 連線生命週期解耦；前端 TypeWriter 動畫維持，視覺體驗不退化。
2. **Layer 2**：batch 呼叫，程式碼簡化，支援 `response_format: json_object` 約束（降低解析失敗率）。
3. **Layer 3**：同 Layer 2。
4. `LlmClient` 介面新增 `chat()` 方法，`streamChat()` 保留（向後相容，假串流回放可用）。

---

## 整體架構變化

```
現在（Layer 1 串流）：
  SSE 連線 ──── for await delta ──── yield delta ──── reply.raw.write
  （LLM 與 SSE 連線生命週期綁定）

改後（Layer 1 batch）：
  LLM batch call ──── 全文取回 ──── 推進 TurnBuffer ──── reply.raw.write（或失敗靜默）
  （LLM 完成後才接觸 SSE；斷線不影響 LLM 呼叫與落地）
```

Layer 2 / 3 的變化僅限程式碼簡化，不影響呼叫端介面或前端。

---

## Section 1：`LlmClient` 介面擴充

### 新增方法

```typescript
export interface LlmClient {
  /** 串流對話（保留：假串流回放、自架模型串流仍可用） */
  streamChat(messages: ChatMessage[]): AsyncIterable<string>;
  /** 批次對話：等待全文再回傳（Layer 1/2/3 主要路徑） */
  chat(messages: ChatMessage[]): Promise<string>;
}
```

### `createOpenAiClient` 實作

```typescript
async chat(messages: ChatMessage[]): Promise<string> {
  const startedAt = Date.now();
  try {
    const resp = await openai.chat.completions.create({
      model: config.openai.model,
      messages,
      stream: false,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    });
    const text = resp.choices[0]?.message?.content ?? "";
    await appendUsageLog(usageLogPath, { ... });
    return text;
  } catch (err) {
    logger.error({ err }, "llm batch 呼叫失敗");
    throw err;
  }
}
```

Layer 2 / 3 的 `controlClient` / `loreClient` 在建立時可額外傳入 `responseFormat: "json_object"`，`createOpenAiClient` 若有此選項則在 batch call 加上 `response_format: { type: "json_object" }`（串流路徑不加，避免相容性問題）。

---

## Section 2：Layer 1（主腦）改為 batch

### `turn-core.ts` 變更

```typescript
// 改前
let narrative = "";
for await (const delta of deps.client.streamChat(plan.messages)) {
  narrative += delta;
  yield { type: "delta", text: delta };
}

// 改後
const narrative = toTraditional((await deps.client.chat(plan.messages)).trim());
yield { type: "delta", text: narrative };
```

**重點**：
- `yield { type: "delta", text: narrative }` 仍然存在，讓 `TurnBuffer` 累積完整敘事、讓前端 TypeWriter 取得全文。
- 單一大 delta 對前端 TypeWriter 無影響：TypeWriter 把每個 delta 的字元逐一推入 queue，不論 delta 大小。
- 繁體化在取得全文後一次性處理（現有邏輯不變）。

### `turn.ts` SSE 寫入防錯

batch 呼叫完成後才寫 SSE，但仍需防止斷線時 `reply.raw.write()` 拋錯中斷後續落地：

```typescript
function safeWrite(raw: ServerResponse, data: string): void {
  try {
    raw.write(data);
  } catch {
    // 客戶端已斷線；buffer 已有資料，斷線不影響落地
  }
}
```

所有 `reply.raw.write(...)` 改為 `safeWrite(reply.raw, ...)`。

### 連線斷線行為（改後）

| 斷線時間點 | 現在 | 改後 |
|---|---|---|
| LLM 呼叫進行中 | `reply.raw.write` 最終失敗，回合可能提早結束 | LLM batch 不依賴 SSE，繼續跑到完成 |
| 落地 / commit 中 | 同上 | SSE write 靜默失敗，落地繼續 |
| 事件寫入 SSE 時 | 拋錯進 catch，`turnInProgress` 正確清除 | safeWrite 靜默，所有事件在 buffer；重連走 `/api/turn/stream?offset=0` |

---

## Section 3：Layer 2（fast-control）改為 batch

### `turn-core.ts` 變更

```typescript
// 改前
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  raw = "";
  try {
    for await (const delta of controlClient.streamChat(plan.buildFastControl(narrative))) {
      raw += delta;
    }
    control = traditionalizeFastControl(parseFastControlOutput(raw));
    break;
  } catch (err) { ... }
}

// 改後
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    raw = await controlClient.chat(plan.buildFastControl(narrative));
    control = traditionalizeFastControl(parseFastControlOutput(raw));
    break;
  } catch (err) { ... }
}
```

**額外收益**：若 `controlClient` 建立時帶 `responseFormat: "json_object"`，提供者（如 OpenAI、vLLM）會在模型層強制輸出合法 JSON，重試次數預期下降。

---

## Section 4：Layer 3（reactive-lore-sync）改為 batch

`runIngest` 內部有多個 LLM 呼叫（NPC / item / scene / dungeon_wiki 各一）。在 `ingest.ts` 中：

```typescript
// 改前（各呼叫）
let raw = "";
for await (const delta of client.streamChat(msgs)) { raw += delta; }

// 改後
const raw = await client.chat(msgs);
```

Layer 3 同樣可帶 `responseFormat: "json_object"`。  
Layer 3 的 `loreClient` 若未設定，退回使用 `controlClient`（現有 fallback 邏輯不變）。

---

## Section 5：假串流（前端不需改動）

前端 TypeWriter 邏輯（`pendingQueue` + 25ms interval）已相容大 delta：

```
收到 delta event { text: "完整敘事一萬字..." }
  → 逐字推入 pendingQueue
  → TypeWriter 每 25ms 取一字顯示
  → 視覺效果：打字機動畫，與原本無異
```

前端無需感知 delta 是「多個小塊」還是「單一大塊」。

---

## Section 6：測試策略

### 單元測試（Vitest）

- `LlmClient.chat()` 正常路徑：回傳完整字串，寫入 usage log。
- `LlmClient.chat()` 失敗：拋錯，不寫 usage log。
- `runTurnCore` Layer 1 batch：`client.chat` 被呼叫一次，`streamChat` 不被呼叫；yield 一個 `delta` event。
- Layer 2 batch：`controlClient.chat` 被呼叫，`raw` 直接為回傳值；重試邏輯不變。
- `safeWrite`：socket 關閉時不拋錯。

### 整合測試（server.inject 或 Playwright）

- 完整回合跑完後 `TurnBuffer.events` 含正確 delta + done。
- `/api/turn/stream?offset=0` 重連後收到完整 delta 事件，TypeWriter 可動畫。

### 手動驗證

- 回合進行中切換 tab → 重新打開 → TypeWriter 從頭動畫，顯示完整敘事。
- 回合進行中關閉瀏覽器 → 重開 → `/api/turn/status` 若 `active=false`，`fetchState()` 還原最後落地狀態。

---

## Section 7：不在範圍內

- 前端假串流控速調整（TYPEWRITER_INTERVAL_MS 等常數不動）。
- `streamChat()` 移除（保留以供自架模型偏好串流時仍可注入 fake client）。
- Layer 1 多 delta 切片（單一大 delta 已足夠，不需伺服器端人工分段）。
- Anthropic Batch API（非同步佇列，不適合回合制即時互動）。
