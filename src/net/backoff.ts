/**
 * 指数退避 + 抖动
 * 参考：Exponential Backoff and Jitter (Full Jitter)
 *
 * attempt: 第几次重试（从 1 开始）
 * baseMs: 基础毫秒
 * maxMs: 最大毫秒上限
 */
export function exponentialJitter(attempt: number, baseMs: number, maxMs: number): number {
  const a = Math.max(1, Math.floor(attempt));
  const exp = Math.min(maxMs, baseMs * Math.pow(2, a - 1));
  const sleep = Math.floor(Math.random() * exp);
  return Math.max(0, Math.min(sleep, maxMs));
}

/**
 * promiseWithTimeout: 为一个 Promise 添加超时
 */
export async function promiseWithTimeout<T>(p: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (timeoutMs <= 0 && !signal) {
    return p;
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        reject(new Error('aborted'));
      }
    };
    if (signal) {
      if (signal.aborted) {
        return reject(new Error('aborted'));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const t = timeoutMs > 0 ? setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('timeout'));
      }
    }, timeoutMs) : undefined;

    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          if (t) clearTimeout(t);
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(v);
        }
      },
      (e) => {
        if (!settled) {
          settled = true;
          if (t) clearTimeout(t);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      }
    );
  });
}

export interface RetryOptions {
  maxRetries: number; // 最大重试次数
  baseBackoffMs: number;
  maxBackoffMs: number;
  shouldRetry?: (err: unknown) => boolean; // 返回 true 则进入重试
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

/**
 * 带指数退避的重试执行器，支持 AbortSignal 取消
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number, signal?: AbortSignal) => Promise<T>,
  options: RetryOptions,
  signal?: AbortSignal
): Promise<T> {
  const {
    maxRetries,
    baseBackoffMs,
    maxBackoffMs,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      if (signal?.aborted) {
        throw new Error('aborted');
      }
      return await fn(attempt, signal);
    } catch (err) {
      const can = attempt <= maxRetries && shouldRetry(err);
      if (!can) {
        throw err;
      }
      const delay = exponentialJitter(attempt, baseBackoffMs, maxBackoffMs);
      onRetry?.({ attempt, delay, error: err });
      // 等待退避时间，支持取消
      await new Promise<void>((resolve, reject) => {
        const tid = setTimeout(() => {
          cleanup();
          resolve();
        }, delay);
        const onAbort = () => {
          cleanup();
          reject(new Error('aborted'));
        };
        const cleanup = () => {
          clearTimeout(tid);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
        };
        if (signal) {
          if (signal.aborted) {
            cleanup();
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      // 下一轮
    }
  }
}