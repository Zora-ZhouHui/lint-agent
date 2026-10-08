// 终端彩色日志（关键要求 8：终端友好）
import chalk from 'chalk';

export const logger = {
  info(msg: string): void {
    console.log(chalk.blue('ℹ ') + msg);
  },
  success(msg: string): void {
    console.log(chalk.green('✔ ') + msg);
  },
  warn(msg: string): void {
    console.log(chalk.yellow('⚠ ') + msg);
  },
  error(msg: string): void {
    console.log(chalk.red('✖ ') + msg);
  },
  title(msg: string): void {
    console.log('\n' + chalk.bold.cyan(`════ ${msg} ════`) + '\n');
  },
};
