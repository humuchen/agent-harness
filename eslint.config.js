// 根 ESLint 配置（flat config，ESLint 9）。
//
// 定位：增量式「卫生基线」，不是一次性大扫除。规则以 **warn** 为主，
// 不阻断 build/test（`pnpm lint` 默认只报告，不在 CI 失败）；待团队逐步清零后，
// 再把关键项升级为 error。
//
// 已规避与现有代码风格冲突的强规则：
//  - 项目大量使用 `as any` 做跨运行时兼容（client 零依赖、server 动态 require core），
//    故 no-explicit-any 仅 warn；
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
      // 真正的错误信号：未使用变量/导入（死代码）。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // 跨运行时兼容需要 as any，仅提示不阻断。
      '@typescript-eslint/no-explicit-any': 'warn',
      // 禁止提交 TODO/FIXME 遗留（项目当前 0 处，保持）。
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme', 'xxx'], location: 'start' }],
      // 以下 recommended 规则在本项目属「已知且有意」的用法，降级为 warn，避免 lint 失败：
      //  - 动态 require 用于加载可选依赖 / 打破循环依赖（core/server 既有模式）；
      //  - 其它为风格类（const、转义、空白、空块），逐步清理即可。
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-useless-assignment': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-empty': 'warn',
      'prefer-const': 'warn',
      // 其余 recommended 风格/异常规则，降级为 warn：
      'preserve-caught-error': 'warn',
      'no-misleading-character-class': 'warn',
      'no-self-assign': 'warn'
    }
  }
);
