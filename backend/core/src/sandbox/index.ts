// OS 级沙箱模块公开面。
//
// 四类原语（命名空间隔离 / 系统调用过滤 / 资源限制 / 权限控制）的实现集合。
// 消费方通常不需要直接创建 OSSandboxExecutor —— 通过 builtins/sandbox.ts 的
// createSandboxExecutor({ backend: 'os', osProfile }) 即可在既有「逻辑沙箱」之后接入。

export * from './types';
export * from './capabilities';
export * from './profiles';
export * from './detect';
export * from './policy';
export * from './args';
export * from './executor';
