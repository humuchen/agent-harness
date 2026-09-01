#!/usr/bin/env node

/**
 * 插件脚手架脚本 - 快速创建新插件
 *
 * 使用方式:
 *   node scripts/create-plugin.cjs <plugin-name>
 *
 * 示例:
 *   node scripts/create-plugin.cjs my-customer-service
 *   node scripts/create-plugin.cjs education-lead
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = process.argv[2];

if (!PLUGIN_NAME) {
  console.error('❌ 用法: node scripts/create-plugin.cjs <plugin-name>');
  console.error('');
  console.error('示例:');
  console.error('  node scripts/create-plugin.cjs my-customer-service');
  console.error('  node scripts/create-plugin.cjs education-lead');
  process.exit(1);
}

const PLUGIN_DIR = path.join(__dirname, '..', 'plugins', PLUGIN_NAME);

// 检查是否已存在
if (fs.existsSync(PLUGIN_DIR)) {
  console.error(`❌ 插件目录已存在: ${PLUGIN_DIR}`);
  process.exit(1);
}

console.log(`🚀 创建插件: ${PLUGIN_NAME}`);
console.log(`📁 目录: ${PLUGIN_DIR}\n`);

// 创建目录结构
const dirs = [
  'src',
  'src/tools',
  'src/services',
  'src/repo',
  'src/infra',
  'src/web',
  'test',
  'scripts',
  'docs',
  'knowledge',
  'knowledge/domain',
  'knowledge/compliance',
  'knowledge/metrics',
  'knowledge/org',
  'knowledge/benchmark',
  'data'
];

console.log('📂 创建目录结构...');
dirs.forEach((dir) => {
  const fullPath = path.join(PLUGIN_DIR, dir);
  fs.mkdirSync(fullPath, { recursive: true });
  console.log(`   ✅ ${dir}/`);
});

// 生成 package.json
console.log('\n📦 生成 package.json...');
const packageJson = {
  name: `@agent-harness/plugin-${PLUGIN_NAME}`,
  version: '0.1.0',
  private: true,
  description: `Agent-Harness 插件: ${PLUGIN_NAME}`,
  main: 'dist/index.js',
  scripts: {
    build: 'tsc -p tsconfig.json',
    start: 'node dist/index.js',
    dev: 'tsc -p tsconfig.json && node dist/index.js',
    test: 'node --test test/*.test.cjs',
    smoke: 'node smoke.cjs'
  },
  dependencies: {
    '@agent-harness/core': 'workspace:*'
  },
  devDependencies: {
    '@types/node': '^20.11.0',
    typescript: '^5.4.5'
  }
};

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'package.json'),
  JSON.stringify(packageJson, null, 2) + '\n'
);
console.log('   ✅ package.json');

// 生成 tsconfig.json
console.log('\n⚙️  生成 tsconfig.json...');
const tsconfig = {
  extends: '../../tsconfig.base.json',
  compilerOptions: {
    rootDir: 'src',
    outDir: 'dist',
    declaration: true,
    paths: {
      '@agent-harness/core': ['../../backend/core/dist/index.d.ts']
    }
  },
  include: ['src/**/*.ts']
};

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'tsconfig.json'),
  JSON.stringify(tsconfig, null, 2) + '\n'
);
console.log('   ✅ tsconfig.json');

// 生成 manifest.json（与 @agent-harness/core 的 PluginManifest 接口对齐，单一事实来源）
console.log('\n📋 生成 manifest.json...');
const manifest = {
  id: PLUGIN_NAME,
  name: PLUGIN_NAME.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  version: '0.1.0',
  description: `插件描述 - 请修改为实际描述`,
  domain: 'generic',
  transport: 'local',
  entry: 'dist/index.js',
  isolation: 'none',
  // capabilities 用对象写法（{id}），与早期字符串写法经 normalizeManifest 自动兼容。
  capabilities: [{ id: 'chat' }, { id: 'tools' }]
};

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log('   ✅ manifest.json');

// 生成主入口文件
console.log('\n📝 生成源代码文件...');
const indexTs = `/**
 * ${manifest.name} 插件主入口
 *
 * 以 PluginModule 形态导出（与 memo / customer-service / medical-aesthetics-lead 完全一致）：
 * bootstrap 消费 default 或命名导出 plugin / 具名 manifest。
 */
import type { PluginModule, PluginContext } from '@agent-harness/core';
import { manifest } from './manifest';
import { prompts } from './prompts';

export const plugin: PluginModule = {
  manifest,
  async setup(ctx: PluginContext): Promise<void> {
    // 在此注册工具 / 服务端扩展 / 前端视图 / 订阅事件。
    ctx.logger.info('[${PLUGIN_NAME}] plugin setup');
  },
  async onStart(ctx: PluginContext): Promise<void> {
    ctx.logger.info('[${PLUGIN_NAME}] plugin started');
  },
};

export { manifest } from './manifest';
export { prompts } from './prompts';
export default plugin;

// 工具注册
export * as tools from './tools';

// 服务层
export * as services from './services';
`;

fs.writeFileSync(path.join(PLUGIN_DIR, 'src', 'index.ts'), indexTs);
console.log('   ✅ src/index.ts');

// 生成 manifest.ts（与 @agent-harness/core PluginManifest 接口对齐）
const manifestTs = `import type { PluginManifest } from '@agent-harness/core';

export const manifest: PluginManifest = ${JSON.stringify(manifest, null, 2)};
`;

fs.writeFileSync(path.join(PLUGIN_DIR, 'src', 'manifest.ts'), manifestTs);
console.log('   ✅ src/manifest.ts');

// 生成 prompts.ts
const promptsTs = `/**
 * 系统提示词配置
 */

export const prompts = {
  system: \`你是一个${manifest.name}助手。

## 职责
- 请根据实际需求修改职责描述

## 规则
1. 请根据实际需求修改规则
2. 遵守相关法律法规
3. 提供专业、准确的信息
\`,

  greeting: '你好!我是${manifest.name}助手,有什么可以帮您的?',
};
`;

fs.writeFileSync(path.join(PLUGIN_DIR, 'src', 'prompts.ts'), promptsTs);
console.log('   ✅ src/prompts.ts');

// 生成占位工具文件
console.log('\n🔧 生成工具文件...');
const exampleToolTs = `/**
 * 示例工具 - 请根据实际需求修改
 */

import type { ToolDefinition } from '@agent-harness/core';

export const exampleTool: ToolDefinition = {
  name: 'example_tool',
  description: '示例工具描述',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '查询内容',
      },
    },
    required: ['query'],
  },
  execute: async (input: { query: string }) => {
    // 实现工具逻辑
    return {
      ok: true,
      result: \`处理查询: \${input.query}\`,
    };
  },
};
`;

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'src', 'tools', 'example.ts'),
  exampleToolTs
);
console.log('   ✅ src/tools/example.ts');

// 生成占位服务文件
console.log('\n🛠️  生成服务文件...');
const exampleServiceTs = `/**
 * 示例服务 - 请根据实际需求修改
 */

export interface ExampleServiceConfig {
  apiKey?: string;
  baseUrl?: string;
}

export function createExampleService(config: ExampleServiceConfig = {}) {
  return {
    async query(input: string) {
      // 实现服务逻辑
      return {
        ok: true,
        data: input,
      };
    },
  };
}
`;

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'src', 'services', 'example-service.ts'),
  exampleServiceTs
);
console.log('   ✅ src/services/example-service.ts');

// 生成 smoke 测试
console.log('\n🧪 生成 smoke 测试...');
const smokeCjs = `/**
 * Smoke 测试 - 验证插件基本功能
 */

const assert = require('node:assert');

async function smoke() {
  console.log('🧪 运行 smoke 测试...');

  // 导入插件
  const mod = require('./dist/index');

  // 验证 manifest（与 PluginManifest 接口对齐）
  const manifest = mod.manifest ?? mod.plugin?.manifest;
  assert.ok(manifest && manifest.id, 'manifest.id 应存在');
  assert.ok(manifest.name, 'manifest.name 应存在');
  console.log('✅ manifest 验证通过');

  // 验证 PluginModule 形态
  const plugin = mod.plugin ?? mod.default;
  assert.ok(plugin && typeof plugin.setup === 'function', 'plugin.setup 应存在');
  console.log('✅ PluginModule 验证通过');

  console.log('\\n✅ Smoke 测试通过!');
}

smoke().catch((err) => {
  console.error('❌ Smoke 测试失败:', err);
  process.exit(1);
});
`;

fs.writeFileSync(path.join(PLUGIN_DIR, 'smoke.cjs'), smokeCjs);
console.log('   ✅ smoke.cjs');

// 生成 README
console.log('\n📚 生成 README...');
const readme = `# ${manifest.name}

${manifest.description}

## 快速开始

### 1. 安装依赖

\`\`\`bash
pnpm install
\`\`\`

### 2. 构建

\`\`\`bash
pnpm build
\`\`\`

### 3. 运行 Smoke 测试

\`\`\`bash
pnpm smoke
\`\`\`

### 4. 开发

\`\`\`bash
pnpm dev
\`\`\`

## 功能特性

- [ ] 功能1 - 请修改为实际功能
- [ ] 功能2 - 请修改为实际功能
- [ ] 功能3 - 请修改为实际功能

## 工具列表

| 工具名 | 说明 |
|--------|------|
| example_tool | 示例工具 - 请修改 |

## 知识库

知识来源两种可选方式：

- **外部 RAG（推荐，生产）**：用 \`services/rag\` 提供检索，领域知识经入库脚本灌入向量库，运行期经 MCP/HTTP 检索；详见仓库 \`.env.example\` 的 \`MA_RAG_*\` 配置与 \`services/rag/README.md\`。
- **本地知识母版（可选）**：放在 \`knowledge/\` 目录，由插件自行加载：
  - \`knowledge/domain/\` - 领域知识
  - \`knowledge/compliance/\` - 合规规则
  - \`knowledge/metrics/\` - 指标定义
  - \`knowledge/org/\` - 组织配置
  - \`knowledge/benchmark/\` - 基准测试

## 开发指南

详见:
- [插件架构文档](../../docs/03-plugins/agent-plugin-architecture.md)
- [插件实现计划](../../docs/03-plugins/agent-plugin-implementation-plan.md)

## 测试

\`\`\`bash
# 运行单元测试
pnpm test

# 运行smoke测试
pnpm smoke
\`\`\`

## 部署

插件会随主应用一起部署,无需单独部署。

确保在 \`plugins/\` 目录下,框架会自动发现并加载。
`;

fs.writeFileSync(path.join(PLUGIN_DIR, 'README.md'), readme);
console.log('   ✅ README.md');

// 生成 .gitignore
console.log('\n🚫 生成 .gitignore...');
const gitignore = `node_modules/
dist/
*.db
*.db-shm
*.db-wal
.env
`;

fs.writeFileSync(path.join(PLUGIN_DIR, '.gitignore'), gitignore);
console.log('   ✅ .gitignore');

// 完成总结
console.log('\n' + '='.repeat(60));
console.log('✅ 插件创建完成!');
console.log('='.repeat(60));
console.log(`\n📁 插件目录: ${PLUGIN_DIR}`);
console.log('\n📋 下一步:');
console.log('   1. 编辑 package.json - 修改描述和依赖');
console.log('   2. 编辑 manifest.json - 配置插件能力');
console.log('   3. 编辑 src/prompts.ts - 配置系统提示词');
console.log('   4. 添加实际工具到 src/tools/');
console.log('   5. 实现服务层到 src/services/');
console.log('\n🚀 快速开始:');
console.log(`   cd plugins/${PLUGIN_NAME}`);
console.log('   pnpm install');
console.log('   pnpm build');
console.log('   pnpm smoke');
console.log('\n📚 文档:');
console.log('   - docs/03-plugins/agent-plugin-architecture.md');
console.log('   - docs/03-plugins/agent-plugin-implementation-plan.md');
console.log('');
