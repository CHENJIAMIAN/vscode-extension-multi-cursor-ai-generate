import { expect } from 'chai';
import { exponentialJitter, retryWithBackoff } from '../src/net/backoff';

describe('backoff.exponentialJitter()', () => {
  it('应当随 attempt 指数增长且不超过 maxMs', () => {
    const base = 100;
    const max = 2000;
    const s1 = exponentialJitter(1, base, max);
    const s2 = exponentialJitter(2, base, max);
    const s5 = exponentialJitter(5, base, max);

    expect(s1).to.be.at.least(0).and.at.most(base); // [0, base]
    expect(s2).to.be.at.least(0).and.at.most(base * 2); // [0, 2*base]
    expect(s5).to.be.at.least(0).and.at.most(max); // 封顶
  });

  it('attempt 小于 1 时按 1 处理', () => {
    const base = 50;
    const max = 1000;
    const s = exponentialJitter(0, base, max);
    expect(s).to.be.at.least(0).and.at.most(base);
  });
});

describe('backoff.retryWithBackoff()', () => {
  it('在达到最大重试后抛出错误', async () => {
    let called = 0;
    const fn = async () => {
      called += 1;
      throw new Error('always fail');
    };
    let attempts: number[] = [];
    try {
      await retryWithBackoff(fn, {
        maxRetries: 2,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        shouldRetry: () => true,
        onRetry: (info) => attempts.push(info.attempt),
      });
      throw new Error('should not reach here');
    } catch (e: any) {
      expect(e).to.be.instanceOf(Error);
      expect(called).to.be.at.least(3); // 初次 + 2 次重试
      expect(attempts).to.deep.equal([1, 2]);
    }
  });

  it('支持 AbortSignal 取消', async () => {
    const controller = new AbortController();
    let called = 0;
    const fn = async (_attempt: number, signal?: AbortSignal) => {
      called += 1;
      // 第一次调用即等待，然后被取消
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (signal?.aborted) {
        throw new Error('aborted');
      }
      throw new Error('fail');
    };

    const p = retryWithBackoff(fn, {
      maxRetries: 5,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      shouldRetry: () => true,
    }, controller.signal);

    setTimeout(() => controller.abort(), 20);

    try {
      await p;
      throw new Error('should not resolve');
    } catch (e: any) {
      expect(e.message).to.match(/aborted|abort/i);
      expect(called).to.equal(1);
    }
  });
});