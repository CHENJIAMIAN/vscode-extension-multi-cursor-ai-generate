import { expect } from 'chai';
import { TokenBucketPool } from '../src/net/rateLimiter';

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe('rateLimiter.TokenBucketPool', () => {
  it('应限制最大并发数', async () => {
    const rl = new TokenBucketPool({
      maxConcurrency: 2,
      maxPerMinute: 120, // 足够高，避免令牌限制影响
    });
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 6 }).map((_, i) =>
      rl.schedule(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await delay(50);
        running -= 1;
        return i;
      })
    );

    const res = await Promise.all(tasks);
    expect(res).to.have.length(6);
    expect(maxRunning).to.equal(2);
    rl.dispose();
  });

  it('应在初始令牌耗尽后按令牌桶进行节流（每分钟上限）', async function () {
    this.timeout(3000);
    const rl = new TokenBucketPool({
      maxConcurrency: 200,
      maxPerMinute: 120, // 平均每秒 2 个，初始令牌容量为 120
    });

    const timestamps: number[] = [];
    const start = Date.now();

    const tasks = Array.from({ length: 122 }).map((_, i) =>
      rl.schedule(async () => {
        timestamps.push(Date.now());
        return i;
      })
    );

    await Promise.all(tasks);
    // 前 120 个请求可使用初始令牌立即启动；其余请求必须等待令牌补充。
    const elapsed = Date.now() - start;
    expect(elapsed).to.be.greaterThan(300);
    rl.dispose();
  });

  it('应应用服务端速率提示（Retry-After 与 limitPerMinuteHint）', async () => {
    const rl = new TokenBucketPool({
      maxConcurrency: 3,
      maxPerMinute: 60,
    });

    rl.applyServerHint({ limitPerMinuteHint: 30 });
    // 间接通过 schedule 触发 refill 逻辑
    const p = rl.schedule(async () => 1);
    await p;

    // 无法直接读取内部字段，至少确保能继续运行
    const r = await rl.schedule(async () => 2);
    expect(r).to.equal(2);

    // 应用 Retry-After，短时间内不应立即启动任务（这里仅做可运行性断言）
    rl.applyServerHint({ retryAfterMs: 200 });
    const t0 = Date.now();
    const pr = rl.schedule(async () => Date.now() - t0);
    const waited = await pr;
    expect(waited).to.be.greaterThan(100);

    rl.dispose();
  });

  it('cancelAll 应中止队列任务', async () => {
    const rl = new TokenBucketPool({
      maxConcurrency: 1,
      maxPerMinute: 1,
    });

    const first = rl.schedule(async () => {
      await delay(100);
      return 'first';
    });

    const second = rl.schedule(async () => 'second');
    const secondResult = second.then(
      () => undefined,
      (error) => error,
    );

    // 立刻取消所有队列中的
    rl.cancelAll();

    const firstRes = await first;
    expect(firstRes).to.equal('first');

    const error = await secondResult;
    expect(String((error as Error | undefined)?.message || error)).to.match(/aborted/i);

    rl.dispose();
  });
});
