/* 
  TokenBucketPool: 并发池 + 令牌桶 限流器
  - 以 maxConcurrency 限制并发执行数
  - 以 maxPerMinute 控制每分钟请求数（令牌桶：容量=速率）
  - 支持动态探测/调整（接收服务端速率提示与 retry-after）
  - 支持任务与全局取消
*/

export interface RateLimiterOptions {
  maxConcurrency: number;
  maxPerMinute: number;
  dynamicProbe?: boolean;
  onMetrics?: (m: RateLimiterMetrics) => void;
  onWarn?: (msg: string) => void;
  onInfo?: (msg: string) => void;
  onDebug?: (msg: string) => void;
}

export interface RateLimiterMetrics {
  running: number;
  queued: number;
  currentRpmLimit: number;
}

export interface ServerRateLimitHint {
  // 从响应头推断的 Retry-After 毫秒
  retryAfterMs?: number;
  // 从响应头推断的新的每分钟上限
  limitPerMinuteHint?: number;
}

type Task<T> = {
  id: number;
  fn: (signal?: AbortSignal) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  controller: AbortController;
};

export class TokenBucketPool {
  private maxConcurrency: number;
  private maxPerMinute: number;

  private running = 0;
  private queue: Task<unknown>[] = [];

  private tokens: number;
  private capacity: number;
  private refillTimer?: ReturnType<typeof setInterval>;
  private lastRefillTs = Date.now();

  private cooldownUntil = 0; // 冷却截止（ms since epoch），遇到429/503或Retry-After时暂停发放
  private dynamicProbe: boolean;

  private nextId = 1;

  private onMetrics?: RateLimiterOptions['onMetrics'];
  private onWarn?: RateLimiterOptions['onWarn'];
  private onInfo?: RateLimiterOptions['onInfo'];
  private onDebug?: RateLimiterOptions['onDebug'];

  constructor(opts: RateLimiterOptions) {
    this.maxConcurrency = Math.max(1, Math.floor(opts.maxConcurrency));
    this.maxPerMinute = Math.max(1, Math.floor(opts.maxPerMinute));
    this.dynamicProbe = !!opts.dynamicProbe;
    this.capacity = this.maxPerMinute;
    this.tokens = this.capacity;
    this.onMetrics = opts.onMetrics;
    this.onWarn = opts.onWarn;
    this.onInfo = opts.onInfo;
    this.onDebug = opts.onDebug;

    // 每 200ms 按比例补充（平滑）
    this.refillTimer = setInterval(() => this.refill(), 200);
    this.emitMetrics();
  }

  public dispose() {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = undefined;
    }
    this.queue.forEach(t => {
      try {
        t.controller.abort();
      } catch { /* ignore */ }
    });
    this.queue = [];
  }

  public updateLimits(lim: { maxConcurrency: number; maxPerMinute: number }) {
    this.maxConcurrency = Math.max(1, Math.floor(lim.maxConcurrency));
    const newRpm = Math.max(1, Math.floor(lim.maxPerMinute));
    this.maxPerMinute = newRpm;
    this.capacity = newRpm;
    // 避免瞬时补满，令牌上限为新容量
    this.tokens = Math.min(this.tokens, this.capacity);
    this.info(`更新限流参数: 并发=${this.maxConcurrency}, RPM=${this.maxPerMinute}`);
    this.emitMetrics();
    this.maybeStart();
  }

  public schedule<T>(fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    const controller = new AbortController();

    // 若外部 signal 取消，则透传至该任务
    if (signal) {
      if (signal.aborted) {
        return Promise.reject(new Error('aborted'));
      }
    }

    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = {
        id,
        fn,
        resolve,
        reject,
        controller,
      };

      // 绑定外部取消
      const onAbort = () => {
        try {
          controller.abort();
        } catch { /* ignore */ }
        // 如果任务仍在队列中，直接拒绝并移除
        const idx = this.queue.findIndex(q => q.id === id);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error('aborted'));
          this.emitMetrics();
        }
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // 入队并尝试启动
      this.queue.push(task as unknown as Task<unknown>);
      this.debug(`任务入队 #${id}，当前队列=${this.queue.length}`);
      this.emitMetrics();
      this.maybeStart();
    });
  }

  public cancelAll() {
    this.warn('收到全局取消：将中止队列中所有任务。');
    // 中止队列任务
    this.queue.forEach(t => {
      try {
        t.controller.abort();
        t.reject(new Error('aborted'));
      } catch { /* ignore */ }
    });
    this.queue = [];
    this.emitMetrics();
  }

  public applyServerHint(hint: ServerRateLimitHint) {
    if (typeof hint.retryAfterMs === 'number' && hint.retryAfterMs > 0) {
      const until = Date.now() + hint.retryAfterMs;
      if (until > this.cooldownUntil) {
        this.cooldownUntil = until;
      }
      this.warn(`接收 Retry-After 提示：暂停发放至 ${new Date(this.cooldownUntil).toISOString()} (${hint.retryAfterMs}ms)。`);
    }
    if (this.dynamicProbe && typeof hint.limitPerMinuteHint === 'number' && hint.limitPerMinuteHint > 0) {
      const adjusted = Math.max(1, Math.floor(hint.limitPerMinuteHint));
      if (adjusted !== this.maxPerMinute) {
        this.info(`接收速率上限提示：RPM ${this.maxPerMinute} -> ${adjusted}`);
        this.updateLimits({ maxConcurrency: this.maxConcurrency, maxPerMinute: adjusted });
      }
    }
  }

  private refill() {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTs;
    this.lastRefillTs = now;

    // 按每分钟上限平滑补充
    const perMs = this.maxPerMinute / 60000;
    const add = perMs * elapsedMs;
    this.tokens = Math.min(this.capacity, this.tokens + add);

    this.maybeStart();
  }

  private canStart(): boolean {
    if (this.running >= this.maxConcurrency) {
      return false;
    }
    if (Date.now() < this.cooldownUntil) {
      return false;
    }
    if (this.tokens < 1) {
      return false;
    }
    return this.queue.length > 0;
  }

  private maybeStart() {
    while (this.canStart()) {
      // 启动一个任务
      const t = this.queue.shift();
      if (!t) break;

      // 消耗 1 个令牌（不足 1 时向下取整，确保每任务至少消耗 1）
      const before = this.tokens;
      this.tokens = Math.max(0, this.tokens - 1);
      this.running += 1;
      this.debug(`启动任务 #${t.id}，并发=${this.running}，令牌 ${before.toFixed(2)} -> ${this.tokens.toFixed(2)}，队列=${this.queue.length}`);
      this.emitMetrics();

      const localSignal = t.controller.signal;
      // 执行并挂接完成回调
      Promise.resolve()
        .then(() => t.fn(localSignal))
        .then(
          (res) => {
            this.running -= 1;
            this.debug(`任务完成 #${t.id}，并发=${this.running}`);
            t.resolve(res);
            this.emitMetrics();
            this.maybeStart();
          },
          (err) => {
            this.running -= 1;
            // 对于 429/503 情况通常在上层 HttpClient 调用 applyServerHint
            this.warn(`任务失败 #${t.id}: ${(err && (err.message || err.toString())) ?? err}`);
            t.reject(err);
            this.emitMetrics();
            this.maybeStart();
          }
        );
    }
  }

  private emitMetrics() {
    this.onMetrics?.({
      running: this.running,
      queued: this.queue.length,
      currentRpmLimit: this.maxPerMinute,
    });
  }

  private warn(msg: string) {
    this.onWarn?.(msg);
  }
  private info(msg: string) {
    this.onInfo?.(msg);
  }
  private debug(msg: string) {
    this.onDebug?.(msg);
  }
}