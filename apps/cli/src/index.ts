#!/usr/bin/env node
import { Command } from 'commander';
import { AnalystError } from '@data-analyst/contracts';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerVersionCommand } from './commands/version.js';
import { registerComponentsCommand } from './commands/components.js';
import { registerConfigCommand } from './commands/config.js';
import { registerServeCommand } from './commands/serve.js';
import { registerM1Commands } from './commands/m1.js';
import { registerM2Commands } from './commands/m2.js';
import { registerM3Commands } from './commands/m3.js';

// ---------------------------------------------------------------------------
// W5 — CLI。M0 提供环境自检、离线版本摘要、配置校验与受控 DSH 启动桩;
// M1 增补 workspace/import/analyze/export 文件分析闭环命令(§17/§24);
// M3 增补数据源接入、只读 SQL、运行治理与 m3-demo 演示链路;
// 绝不在 CLI 内安装依赖(§7/§24)。
// ---------------------------------------------------------------------------

const program = new Command();
program.name('data-analyst').description('数据分析 Agent CLI(M1)').version('0.1.0-dev');

registerDoctorCommand(program);
registerVersionCommand(program);
registerComponentsCommand(program);
registerConfigCommand(program);
registerServeCommand(program);
registerM1Commands(program);
registerM2Commands(program);
registerM3Commands(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof AnalystError) {
    console.error(JSON.stringify(error.payload, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
