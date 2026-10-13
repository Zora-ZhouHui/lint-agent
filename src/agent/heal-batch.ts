// 批次级降级：`heal_*` 每次都是一个整批请求，任一条不合法就整批作废。
//
// 实测过的真实失效（见 README「运行间方差与一个已知韧性缺陷」）：LLM 把 `name` 字段
// 填成了 API 路径（`"name":"jue.router.navigateTo"`），违反 kebab-case 的 Zod 校验，
// 于是**一条格式错误导致整个 9 条漏提批次的修正全部作废**，漏提原样保留 3 轮。
//
// 因此策略是「先整批、失败再逐条」：
//   - 成功路径（绝大多数情况）零额外成本，仍是一次调用；
//   - 失败路径把批次拆成单条重试，**保留已通过校验的那部分**，一条坏数据不再拖垮整批。
//
// 两个防雪崩设计：
//   1. **先探测**：整批失败时先只重试第一条；若第一条也失败，说明是系统性故障
//      （限流 / 网络 / Key 失效），立刻放弃，避免 9 条全部无效重试；
//   2. **上限**：逐条重试条数不超过 maxFallbackItems，成本可预测。

/** 逐条降级的默认上限（条数）。 */
export const DEFAULT_MAX_FALLBACK_ITEMS = 12;

export interface FallbackOptions {
  /** 逐条重试的条数上限，默认 DEFAULT_MAX_FALLBACK_ITEMS */
  maxFallbackItems?: number;
}

export interface FallbackOutcome<R> {
  /** 成功解析出的条目（整批成功时就是整批结果） */
  items: R[];
  /** 整批是否成功（未走降级） */
  batchSucceeded: boolean;
  /** 整批失败与逐条失败的错误信息（按发生顺序） */
  errors: string[];
  /** 逐条重试实际发生的调用次数（0 表示未降级或探测即放弃） */
  fallbackCalls: number;
  /** 是否因探测失败而放弃逐条重试（系统性故障） */
  abortedOnProbe: boolean;
  /** 因超过上限而未逐条重试的条数 */
  skippedByLimit: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 先整批调用，失败则逐条降级重试并保留成功部分。
 *
 * @param items      要处理的条目（每条会单独构造一次 prompt：`batch` 只含该条）
 * @param callBatch  用给定子集发起一次调用并解析结果（失败即抛）
 * @param options    降级上限
 */
export async function callWithItemFallback<I, R>(
  items: I[],
  callBatch: (batch: I[]) => Promise<R[]>,
  options: FallbackOptions = {},
): Promise<FallbackOutcome<R>> {
  const maxFallbackItems = options.maxFallbackItems ?? DEFAULT_MAX_FALLBACK_ITEMS;
  const errors: string[] = [];

  if (items.length === 0) {
    return {
      items: [],
      batchSucceeded: true,
      errors,
      fallbackCalls: 0,
      abortedOnProbe: false,
      skippedByLimit: 0,
    };
  }

  // 1) 整批优先：成功则零额外成本
  try {
    const all = await callBatch(items);
    return {
      items: all,
      batchSucceeded: true,
      errors,
      fallbackCalls: 0,
      abortedOnProbe: false,
      skippedByLimit: 0,
    };
  } catch (err) {
    errors.push(errMessage(err));
  }

  // 2) 探测：只重试第一条。也失败 → 判定为系统性故障，放弃降级（避免无效重试风暴）
  const limit = Math.min(items.length, maxFallbackItems);
  const first = items[0];
  let collected: R[];
  try {
    collected = await callBatch([first]);
  } catch (err) {
    errors.push(errMessage(err));
    return {
      items: [],
      batchSucceeded: false,
      errors,
      fallbackCalls: 1,
      abortedOnProbe: true,
      skippedByLimit: Math.max(0, items.length - 1),
    };
  }

  // 3) 探测成功 → 说明是「个别条目坏掉」，其余逐条重试并保留成功部分
  let fallbackCalls = 1;
  for (const item of items.slice(1, limit)) {
    fallbackCalls++;
    try {
      collected = collected.concat(await callBatch([item]));
    } catch (err) {
      errors.push(errMessage(err));
    }
  }

  return {
    items: collected,
    batchSucceeded: false,
    errors,
    fallbackCalls,
    abortedOnProbe: false,
    skippedByLimit: Math.max(0, items.length - limit),
  };
}
