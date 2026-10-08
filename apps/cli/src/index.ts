#!/usr/bin/env node
import { Command } from 'commander';
import { AnalystError } from '@data-analyst/contracts';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerVersionCommand } from './commands/version.js';
import { registerComponentsCommand } from './commands/components.js';
import { registerConfigCommand } from './commands/config.js';
import { registerServeCommand } from './commands/serve.js';

// ---------------------------------------------------------------------------
// W5 — CLI。M0 仅提供环境自检、离线版本摘要、配置校验与受控 DSH 启动桩;
// 绝不在 CLI 内安装依赖(§7/§24)。
// ---------------------------------------------------------------------------

const program = new Command();
program.name('data-analyst').description('数据分析 Agent CLI(M0)').version('0.1.0-dev');

registerDoctorCommand(program);
registerVersionCommand(program);
registerComponentsCommand(program);
registerConfigCommand(program);
registerServeCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof AnalystError) {
    console.error(JSON.stringify(error.payload, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
