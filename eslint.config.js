// 根 ESLint 配置（flat config，ESLint 9）。
//
// 定位：增量式「卫生基线」+ 关键规则升级为 error（P2）。
//
// 规则分级策略：
//   - error：确定性的 bug 信号（TODO/FIXME 遗留、自赋值、无用赋值），
//     阻断 CI 合并。已验证当前代码库 0 处违规。
//   - warn：风格类与渐进清理项（as any、require、unused-vars），
//     只报告不阻断。由 CI 的 no-explicit-any 棘轮脚本单独管控增量。
//
// 已规避与现有代码风格冲突的强规则：
//  - 项目大量使用 `as any` 做跨运行时兼容（client 零依赖、server 动态 require core），
//    故 no-explicit-any 仅 warn（由 .eslint-any-baseline.json 棘轮管控增量）；
//  - TS 项目不依赖 ESLint 的 no-undef（类型由 tsc 负责）。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/examples/**',
      '**/*.cjs',
      '**/build/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: false // 不开启类型感知规则，避免全量类型检查拖慢与误报
      }
    },
    rules: {
      // TS 项目由 tsc 负责全局声明（process/console 等），ESLint 的 no-undef 在 TS 下误报，关闭。
      'no-undef': 'off',

      // ── error 级（阻断 CI）：确定性 bug 信号 ──────────────────────
      // 禁止提交 TODO/FIXME 遗留（已验证代码库 0 处，P2 升级为 error）。
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'start' }],
      // 自赋值始终是 bug（x = x 无意义）。
      'no-self-assign': 'error',
      // 无用赋值（赋值后从未读取）是死代码信号。
      'no-useless-assignment': 'error',

      // ── warn 级（只报告，渐进清理）────────────────────────────────
      // 未使用变量/导入（死代码）：量大，渐进清理。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // 跨运行时兼容需要 as any，仅提示不阻断（棘轮脚本管控增量）。
      '@typescript-eslint/no-explicit-any': 'warn',
      // 动态 require 用于加载可选依赖 / 打破循环依赖（core/server 既有模式）。
      '@typescript-eslint/no-require-imports': 'warn',
      // 风格类规则，逐步清理。
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-empty': 'warn',
      'prefer-const': 'warn',
      // 其余 recommended 风格/异常规则，降级为 warn：
      'preserve-caught-error': 'warn',
      'no-misleading-character-class': 'warn'
    }
  }
);
