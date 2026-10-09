// Tracer：Agent 每一步的可观测记录（每步落盘，进程中断可恢复）
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { AgentStep } from '../types/index.js';
import { ensureDir } from '../utils/file.js';

const OBSERVATION_MAX_LEN = 300;

export class Tracer {
  private steps: AgentStep[] = [];

  constructor(private filePath: string = path.resolve('output/logs/agent-trace.jsonl')) {}

  append(step: AgentStep): void {
    this.steps.push(step);
  }

  get all(): AgentStep[] {
    return this.steps;
  }

  /** 全量重写为 JSONL（每步一行）。每步都调用，进程中断也能保留已完成部分 */
  save(filePath: string = this.filePath): void {
    ensureDir(path.dirname(filePath));
    const content = this.steps.map((s) => JSON.stringify(s)).join('\n');
    fs.writeFileSync(filePath, content ? content + '\n' : '', 'utf8');
  }

  /** 终端实时打印单步（提取阶段调用） */
  printStep(step: AgentStep): void {
    const failed = step.observation.includes('失败') || step.observation.includes('出错');
    const header = [
      chalk.cyan(`── Step ${step.step}`),
      chalk.dim(`${step.durationMs}ms`),
      step.tokensUsed !== undefined ? chalk.dim(`${step.tokensUsed} tokens`) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(header);
    const obs =
      step.observation.length > OBSERVATION_MAX_LEN
        ? step.observation.slice(0, OBSERVATION_MAX_LEN) + '…'
        : step.observation;
    console.log(failed ? chalk.red(`  👁 ${obs}`) : chalk.green(`  👁 ${obs}`));
  }
}
