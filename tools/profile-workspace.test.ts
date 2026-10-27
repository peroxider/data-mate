import { describe, expect, it } from 'vitest';
import { approvalsBlock, standaloneWorkspaceYaml, BUILD_SCRIPT_PACKAGES } from './profile-workspace.js';

describe('profile workspace 配置生成', () => {
  it('pnpm v11+ 使用 allowBuilds 映射方言', () => {
    const yaml = approvalsBlock(11);
    expect(yaml).toMatch(/^allowBuilds:\n/);
    expect(yaml).toContain("  'node-pty': true");
    expect(yaml).toContain("  '@deepseek-ai/dsh-subprocess-local': true");
    expect(yaml).not.toContain('onlyBuiltDependencies');
  });

  it('pnpm v10 使用 onlyBuiltDependencies 列表方言', () => {
    const yaml = approvalsBlock(10);
    expect(yaml).toMatch(/^onlyBuiltDependencies:\n/);
    expect(yaml).toContain("  - 'koffi'");
    expect(yaml).not.toContain('allowBuilds');
  });

  it('独立 workspace 文件固定 hoisted 布局且覆盖全部五个审批包', () => {
    const yaml = standaloneWorkspaceYaml(11);
    expect(yaml).toContain('packages:\n  - .');
    expect(yaml).toContain('nodeLinker: hoisted');
    for (const name of BUILD_SCRIPT_PACKAGES) {
      expect(yaml).toContain(name);
    }
  });
});
