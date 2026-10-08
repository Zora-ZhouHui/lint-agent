// --planner 参数的校验：把 CLI 字符串收敛为 PlannerMode
import type { PlannerMode } from '../../types/index.js';
import { PLANNER_MODES } from '../../types/index.js';

export function parsePlannerMode(raw: string): PlannerMode {
  if ((PLANNER_MODES as readonly string[]).includes(raw)) {
    return raw as PlannerMode;
  }
  throw new Error(`--planner 取值非法：${raw}（可选：${PLANNER_MODES.join(' | ')}）`);
}
