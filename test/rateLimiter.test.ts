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

  it('应按令牌桶进行节流（每分钟上限）', async function () {
    this.timeout(5000);
    const rl = new TokenBucketPool({
      maxConcurrency: 10,
      maxPerMinute: 60, // 平均每秒 1 个
    });

    const timestamps: number[] = [];
    const start = Date.now();

    const tasks = Array.from({ length: 5 }).map((_, i) =>
      rl.schedule(async () => {
        timestamps.push(Date.now());
        return i;
      })
    );

    await Promise.all(tasks);
    // 5 次请求，理论至少需要 ~4 秒（首个立即，余下每秒 1 个，考虑初始令牌可能略快，这里放宽）
    const elapsed = Date.now() - start;
    expect(elapsed).to.be.greaterThan(2000);
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

    // 立刻取消所有队列中的
    rl.cancelAll();

    const firstRes = await first;
    expect(firstRes).to.equal('first');

    try {
      await second;
      throw new Error('second 应当被取消');
    } catch (e: any) {
      expect(String(e.message || e)).to.match(/aborted/i);
    }

    rl.dispose();
  });
});