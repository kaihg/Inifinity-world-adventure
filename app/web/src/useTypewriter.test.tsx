import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldTypewriterOutput, useTypewriter, TYPEWRITER_INTERVAL_MS_DEFAULT } from "./useTypewriter";

describe("shouldTypewriterOutput", () => {
  it("queue 充足時回 true", () => {
    expect(shouldTypewriterOutput({ queueLength: 25, llmDone: false })).toBe(true);
  });

  it("queue 不足且 LLM 未完成時回 false（lookahead pause）", () => {
    expect(shouldTypewriterOutput({ queueLength: 5, llmDone: false })).toBe(false);
  });

  it("LLM 完成後即使 queue 不足也回 true（排空 queue）", () => {
    expect(shouldTypewriterOutput({ queueLength: 5, llmDone: true })).toBe(true);
  });

  it("queue 為 0 且 LLM 完成 → 回 false（沒字可取）", () => {
    expect(shouldTypewriterOutput({ queueLength: 0, llmDone: true })).toBe(false);
  });
});

describe("useTypewriter", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("enqueue + setLlmDone + start → onOutput 逐字呼叫", () => {
    const onOutput = vi.fn();
    const { result } = renderHook(() => useTypewriter(onOutput));
    act(() => {
      result.current.enqueue("a");
      result.current.enqueue("b");
      result.current.setLlmDone();
      result.current.start();
    });
    act(() => { vi.advanceTimersByTime(TYPEWRITER_INTERVAL_MS_DEFAULT * 10); });
    expect(onOutput).toHaveBeenCalledWith("a");
    expect(onOutput).toHaveBeenCalledWith("b");
    expect(onOutput).toHaveBeenCalledTimes(2);
  });

  it("stop(true) 後 timer 停止且 queue 清空，onOutput 不再呼叫", () => {
    const onOutput = vi.fn();
    const { result } = renderHook(() => useTypewriter(onOutput));
    act(() => {
      result.current.enqueue("x");
      result.current.start();
      result.current.stop(true);
    });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onOutput).not.toHaveBeenCalled();
  });

  it("stop() 不清 queue 時，queue 保留但 timer 已停", () => {
    const onOutput = vi.fn();
    const { result } = renderHook(() => useTypewriter(onOutput));
    act(() => {
      result.current.enqueue("y");
      result.current.start();
      result.current.stop();
    });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onOutput).not.toHaveBeenCalled();
    // 重新啟動後應可輸出
    act(() => {
      result.current.setLlmDone();
      result.current.start();
    });
    act(() => { vi.advanceTimersByTime(TYPEWRITER_INTERVAL_MS_DEFAULT * 5); });
    expect(onOutput).toHaveBeenCalledWith("y");
  });

  it("waitDone 在 typewriter 排空後 resolve", async () => {
    const onOutput = vi.fn();
    const { result } = renderHook(() => useTypewriter(onOutput));
    act(() => {
      result.current.enqueue("z");
      result.current.setLlmDone();
      result.current.start();
    });
    const waitPromise = result.current.waitDone();
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    await waitPromise;
    expect(onOutput).toHaveBeenCalledWith("z");
  });
});
