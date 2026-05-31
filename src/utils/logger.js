import chalk from 'chalk';

const DEBUG = !!process.env.JAMUS_DEBUG;

export const logger = {
  info: (msg) => console.log(msg),
  step: (msg) => console.log(chalk.cyan('› ') + msg),
  success: (msg) => console.log(chalk.green('✔ ') + msg),
  warn: (msg) => console.warn(chalk.yellow('⚠ ') + msg),
  error: (msg) => console.error(chalk.red('✖ ') + msg),
  dim: (msg) => console.log(chalk.dim(msg)),
  debug: (msg) => {
    if (DEBUG) console.log(chalk.gray('[debug] ') + msg);
  },
};
