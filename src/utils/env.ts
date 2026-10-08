// 极简 .env 加载器（零依赖）：启动时把项目根目录 .env 注入 process.env
// 已存在的真实环境变量优先，不被 .env 覆盖
import fs from 'node:fs';
import path from 'node:path';

export function loadDotEnv(root: string = process.cwd()): void {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // 去掉成对的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
