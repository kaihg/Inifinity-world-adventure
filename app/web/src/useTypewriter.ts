import { useRef } from "react";

export const TYPEWRITER_INTERVAL_MS_DEFAULT = 25;
export const LOOKAHEAD_MIN = 20;

export function shouldTypewriterOutput({
  queueLength,
  llmDone,
}: {
  queueLength: number;
  llmDone: boolean;
}): boolean {
  if (queueLength === 0) return false;
  if (!llmDone && queueLength < LOOKAHEAD_MIN) return false;
  return true;
}

/**
 * 封裝打字機的 queue / timer / LLM-done 狀態，供 App 元件直接使用。
 * onOutput 每次取出一個字元時呼叫（例如 setStory(s => s + char)）。
 */
export function useTypewriter(onOutput: (char: string) => void) {
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;

  const pendingQueue = useRef<string[]>([]);
  const llmDoneRef = useRef(false);
  const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const typewriterIntervalMsRef = useRef(TYPEWRITER_INTERVAL_MS_DEFAULT);

  function enqueue(char: string) {
    pendingQueue.current.push(char);
  }

  function start() {
    if (typewriterTimer.current) return;
    typewriterTimer.current = setInterval(() => {
      if (
        shouldTypewriterOutput({
          queueLength: pendingQueue.current.length,
          llmDone: llmDoneRef.current,
        })
      ) {
        const char = pendingQueue.current.shift()!;
        onOutputRef.current(char);
      } else if (llmDoneRef.current && pendingQueue.current.length === 0) {
        clearInterval(typewriterTimer.current!);
        typewriterTimer.current = null;
      }
    }, typewriterIntervalMsRef.current);
  }

  function stop(clearQueue = false) {
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
      typewriterTimer.current = null;
    }
    if (clearQueue) {
      pendingQueue.current = [];
    }
    llmDoneRef.current = false;
  }

  function waitDone(): Promise<void> {
    return new Promise((resolve) => {
      const TIMEOUT_MS = 10_000;
      const timeout = setTimeout(() => {
        clearInterval(check);
        llmDoneRef.current = true;
        resolve();
      }, TIMEOUT_MS);
      const check = setInterval(() => {
        if (!typewriterTimer.current) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, typewriterIntervalMsRef.current);
    });
  }

  function setLlmDone() {
    llmDoneRef.current = true;
  }

  function setIntervalMs(ms: number) {
    typewriterIntervalMsRef.current = ms;
  }

  return { enqueue, start, stop, waitDone, setLlmDone, setIntervalMs };
}
