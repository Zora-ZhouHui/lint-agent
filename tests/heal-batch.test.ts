import { describe, expect, it } from 'vitest';
import { callWithItemFallback } from '../src/agent/heal-batch.js';

/** 记录每次调用收到了哪些条目，便于断言「整批 → 逐条」的实际调用序列。 */
function recorder<T>(fn: (batch: T[]) => T[] | Promise<T[]>) {
  const seen: T[][] = [];
  const call = async (batch: T[]): Promise<T[]> => {
    seen.push(batch);
    return fn(batch);
  };
  return { call, seen };
}

describe('callWithItemFallback（批次级全有或全无 → 逐条降级）', () => {
  it('整批成功 → 只调用一次，不触发降级（成功路径零额外成本）', async () => {
    const { call, seen } = recorder<string>((batch) => batch.map((x) => x.toUpperCase()));
    const out = await callWithItemFallback(['a', 'b', 'c'], call);

    expect(out.items).toEqual(['A', 'B', 'C']);
    expect(out.batchSucceeded).toBe(true);
    expect(out.fallbackCalls).toBe(0);
    expect(out.errors).toEqual([]);
    expect(seen).toHaveLength(1); // 关键：没有多余调用
    expect(seen[0]).toEqual(['a', 'b', 'c']);
  });

  it('整批失败 + 个别条目坏 → 逐条重试并保留成功部分（核心修复）', async () => {
    // 模拟真实失效：整批请求里混入一条不合法数据，导致整批 Zod 校验失败；
    // 拆成单条后，坏的那条仍然失败，但其余全部成功。
    const { call, seen } = recorder<string>((batch) => {
      if (batch.length > 1) throw new Error('整批校验失败（含一条不合法数据）');
      if (batch[0] === 'bad') throw new Error('该条仍不合法');
      return batch.map((x) => x.toUpperCase());
    });

    const out = await callWithItemFallback(['a', 'bad', 'c'], call);

    expect(out.batchSucceeded).toBe(false);
    expect(out.items).toEqual(['A', 'C']); // 好数据被救回来，不再整批作废
    expect(out.errors).toHaveLength(2); // 整批失败 + bad 那条失败
    expect(out.abortedOnProbe).toBe(false);
    // 调用序列：1 次整批 + 3 次逐条
    expect(seen).toHaveLength(4);
    expect(seen[0]).toEqual(['a', 'bad', 'c']);
    expect(seen.slice(1)).toEqual([['a'], ['bad'], ['c']]);
  });

  it('探测（第一条）也失败 → 判定系统性故障，立刻放弃，不做无效重试风暴', async () => {
    const { call, seen } = recorder<string>(() => {
      throw new Error('限流 / Key 失效等系统性故障');
    });

    const out = await callWithItemFallback(['a', 'b', 'c', 'd'], call);

    expect(out.items).toEqual([]);
    expect(out.abortedOnProbe).toBe(true);
    expect(out.fallbackCalls).toBe(1); // 只探测了一次
    expect(seen).toHaveLength(2); // 整批 + 探测，仅此两次
    expect(out.skippedByLimit).toBe(3);
  });

  it('逐条重试受上限约束（成本可预测）', async () => {
    const { call, seen } = recorder<string>((batch) => {
      if (batch.length > 1) throw new Error('整批失败');
      return batch.map((x) => x.toUpperCase());
    });

    const out = await callWithItemFallback(['a', 'b', 'c', 'd', 'e'], call, {
      maxFallbackItems: 2,
    });

    expect(out.items).toEqual(['A', 'B']); // 只救回上限内两条
    expect(out.skippedByLimit).toBe(3);
    expect(seen).toHaveLength(3); // 整批 + 2 条逐条
  });

  it('空输入 → 直接返回空，不发任何调用', async () => {
    const { call, seen } = recorder<string>((batch) => batch);
    const out = await callWithItemFallback<string, string>([], call);

    expect(out.items).toEqual([]);
    expect(out.batchSucceeded).toBe(true);
    expect(seen).toHaveLength(0);
  });
});
