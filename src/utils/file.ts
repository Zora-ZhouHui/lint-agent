// 文件读写小工具：统一目录创建和友好错误信息
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readFileText(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function readJSON<T>(filePath: string): T {
  try {
    return JSON.parse(readFileText(filePath)) as T;
  } catch (err) {
    throw new Error(
      `JSON 解析失败（${filePath}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeJSON(filePath: string, data: unknown): void {
  writeText(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}
