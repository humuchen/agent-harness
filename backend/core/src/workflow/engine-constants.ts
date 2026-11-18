/**
 * workflow 引擎常量（P2-6 从 engine.ts 拆分）。
 *
 * 体积护栏与重试/嵌套上限——纯常量，零逻辑。
 * engine.ts re-export 保持 `from './engine'` 导入点零改动兼容。
 */

/** 单 step 调用链路节点数上限（R5 体积护栏）：超出截断保留早期调用，防止检查点膨胀。 */
export const STEP_TRACE_MAX_NODES = 500;
/** 调用链路单节点 detail 长度上限（截断存储，避免单条长产出拖垮检查点）。 */
export const STEP_TRACE_DETAIL_MAX = 500;

/** P6 重试退避上限毫秒（指数退避封顶，防止 retries 较大时等待失控）。 */
export const RETRY_BACKOFF_MAX_MS = 8_000;
/** P6 重试次数上限（StepDef.retries 收敛，防配置失误打出无界循环）。 */
export const STEP_RETRIES_MAX = 10;
/** P6 动态 fan-out：单个 dynamic step 单次产出的 spawn 数上限（防产出异常打爆 DAG）。 */
export const MAX_DYNAMIC_SPAWN = 50;
/** P6-B subgraph 嵌套深度硬上限（配合 activeChain 环检测，防 defRef 互相引用打爆调用栈）。 */
export const MAX_SUBGRAPH_DEPTH = 5;
