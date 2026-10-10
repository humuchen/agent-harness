/**
 * 零依赖 JSON-Schema 子集校验器（P6 结构化输出闸门基座）。
 *
 * 背景：工具参数（ToolRegistry）与 step 产出（StepDef.outputSchema）此前只有「手写
 * JSON-Schema 描述」而无执行期校验——LLM 传入缺参 / 错型时工具内部各自为战，step 产出
 * 不合规时静默写黑板。本模块提供统一校验入口：
 *   - validateAgainstSchema(value, schema)：返回 { ok, errors }，errors 为带路径的
 *     中文可读信息（可直接拼进 tool error 回喂模型自愈，或写入 step 失败原因）。
 *
 * 覆盖面（项目实际使用的 schema 形态，与 db-dialect 同样的「够用即止」纪律）：
 *   - type：字符串或数组（如 ['string','null']）；object / array / string / number /
 *     integer / boolean / null；
 *   - object：properties / required / additionalProperties（布尔或 schema）/ minProperties /
 *     maxProperties；
 *   - array：items（schema 或元组数组）/ minItems / maxItems / uniqueItems；
 *   - string：minLength / maxLength / pattern；
 *   - number：minimum / maximum / exclusiveMinimum / exclusiveMaximum / multipleOf；
 *   - 组合：enum / const / anyOf / oneOf / allOf / not（P6.1 补齐）；
 *   - OpenAPI 兼容：nullable: true 视为允许 null；
 *   - $ref（P6.1 补齐）：仅支持**本地指针** `#/definitions/...` 与 `#/$defs/...`
 *     （含 ~0/~1 与 URI 解码）；外部 URL / 远程引用无法在零依赖校验器内解析，
 *     按 **fail-closed** 报错拒绝（校验闸门不逃逸——工具参数/step 产出用着它，
 *     静默放行等于没有约束）。
 *
 * 纪律：纯函数、零运行时依赖、未知关键字一律忽略（向前兼容）；错误信息含 JSON 路径
 * （如 `a.b[2]`），单条错误不抛异常（调用方决定如何处置）。
 */

/** 校验结果：ok = 全部通过；errors 为带路径的可读信息（已按条数截断建议在调用方做）。 */
export interface SchemaValidation {
  ok: boolean;
  errors: string[];
}

/** JSON 路径拼接（根为空串；属性用 `.x`，数组用 `[i]`）。 */
function joinPath(base: string, key: string | number): string {
  if (base === '') return typeof key === 'number' ? `[${key}]` : key;
  return typeof key === 'number' ? `${base}[${key}]` : `${base}.${key}`;
}

/** 单值类型判定（type 关键字的字符串形态）。 */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

/** type 关键字匹配（数组形态任一命中即可；integer 接受 number 命中）。 */
function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number' && actual === 'integer') return true;
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

/**
 * 解析本地 JSON Pointer 引用（P6.1）：仅支持 `#/definitions/...` / `#/$defs/...`。
 * 支持 ~0（~）/ ~1（/）转义与 URI 编码段。解析失败 / 非本地指针 → null（调用方 fail-closed）。
 */
function resolveLocalRef(root: unknown, ref: string): Record<string, unknown> | null {
  if (typeof ref !== 'string') return null;
  // 根指针 '#'：整个 root schema 自身（自引用树形结构的惯用写法）
  if (ref === '#') {
    return root !== null && typeof root === 'object' && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : null;
  }
  if (!ref.startsWith('#/')) return null;
  const pointer = ref.slice(1); // 保留开头 '/'
  let cur: unknown = root;
  for (const rawSeg of pointer.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return null;
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    let key = seg;
    try {
      key = decodeURIComponent(seg);
    } catch {
      // 非法 URI 编码：按原样匹配
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur !== null && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : null;
}

/** 组合关键字（anyOf/oneOf/allOf/not/$ref）中优先于 type 校验：先跑组合再跑本层约束。 */
function validate(
  value: unknown,
  schema: unknown,
  path: string,
  errors: string[],
  depth: number,
  root?: unknown
): void {
  // 深度护栏：防御 schema 自引用（$ref 循环）拖垮校验。
  if (depth > 32) {
    errors.push(`${path || '(root)'}: schema 嵌套过深（>32 层），停止校验`);
    return;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return; // 非法 / 缺省 schema：不约束（与「未知关键字忽略」一致）
  }
  const s = schema as Record<string, unknown>;
  const ctxRoot = root === undefined ? schema : root;

  // $ref（P6.1）：本地指针解析后按解析结果校验（draft-07 语义：$ref 优先、忽略兄弟键）。
  // 无法解析（外部 URL / 指针悬空）→ fail-closed 报错，绝不静默放行。
  if (typeof s.$ref === 'string') {
    const resolved = resolveLocalRef(ctxRoot, s.$ref);
    if (!resolved) {
      errors.push(
        `${path || '(root)'}: $ref "${s.$ref}" 无法解析（仅支持本地 #/definitions|#/$defs 指针），按校验失败处理`
      );
      return;
    }
    validate(value, resolved, path, errors, depth + 1, ctxRoot);
    return;
  }

  // 组合：anyOf / oneOf / allOf / not
  if (Array.isArray(s.anyOf)) {
    const passed = s.anyOf.some(
      (sub) => {
        const errs: string[] = [];
        validate(value, sub, path, errs, depth + 1, ctxRoot);
        return errs.length === 0;
      }
    );
    if (!passed) {
      errors.push(`${path || '(root)'}: 不满足 anyOf 任一分支`);
      return;
    }
    return; // anyOf 命中即视为通过（不再叠加本层其它约束，保持简单可预期）
  }
  if (Array.isArray(s.oneOf)) {
    let hit = 0;
    for (const sub of s.oneOf) {
      const errs: string[] = [];
      validate(value, sub, path, errs, depth + 1, ctxRoot);
      if (errs.length === 0) hit += 1;
    }
    if (hit !== 1) {
      errors.push(`${path || '(root)'}: 需恰好满足 oneOf 之一（实际命中 ${hit}）`);
      return;
    }
    return;
  }
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) {
      const before = errors.length;
      validate(value, sub, path, errors, depth + 1, ctxRoot);
      if (errors.length > before) return; // 某分支失败即返回（错误信息已带路径）
    }
    // allOf 全过后继续走本层约束（fall through）
  }
  if (s.not !== undefined && s.not !== null && typeof s.not === 'object') {
    const errs: string[] = [];
    validate(value, s.not, path, errs, depth + 1, ctxRoot);
    if (errs.length === 0) {
      errors.push(`${path || '(root)'}: 值不满足 not 约束（匹配了被禁止的 schema）`);
      return;
    }
  }

  // nullable（OpenAPI 风格）：允许 null 短路通过
  if (value === null && s.nullable === true) return;

  // type（字符串或数组）
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type.map(String) : [String(s.type)];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(
        `${path || '(root)'}: 类型应为 ${types.join(' | ')}，实际为 ${typeOf(value)}`
      );
      return; // 类型不符时不再深入（避免噪声级联）
    }
  }

  // enum / const
  if (Array.isArray(s.enum)) {
    const hit = s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value));
    if (!hit) {
      errors.push(
        `${path || '(root)'}: 值 ${JSON.stringify(value)?.slice(0, 60)} 不在枚举 [${s.enum
          .map((v) => JSON.stringify(v))
          .join(', ')
          .slice(0, 120)}] 内`
      );
      return;
    }
  }
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) {
    errors.push(`${path || '(root)'}: 值须为常量 ${JSON.stringify(s.const)?.slice(0, 60)}`);
    return;
  }

  // object
  if ((s.type === 'object' || s.properties !== undefined || s.required !== undefined) && typeOf(value) === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === 'string' && !(key in obj)) {
          errors.push(`${path || '(root)'}: 缺少必填属性 "${key}"`);
        }
      }
    }
    const props = (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)
      ? s.properties
      : {}) as Record<string, unknown>;
    const additional = s.additionalProperties;
    for (const [key, val] of Object.entries(obj)) {
      const childPath = joinPath(path, key);
      if (key in props) {
        validate(val, props[key], childPath, errors, depth + 1, ctxRoot);
      } else if (additional === false) {
        errors.push(`${childPath}: 不允许的额外属性（additionalProperties=false）`);
      } else if (additional && typeof additional === 'object') {
        validate(val, additional, childPath, errors, depth + 1, ctxRoot);
      }
    }
    if (typeof s.minProperties === 'number' && Object.keys(obj).length < s.minProperties) {
      errors.push(`${path || '(root)'}: 属性数少于 minProperties=${s.minProperties}`);
    }
    if (typeof s.maxProperties === 'number' && Object.keys(obj).length > s.maxProperties) {
      errors.push(`${path || '(root)'}: 属性数超过 maxProperties=${s.maxProperties}`);
    }
  }

  // array
  if ((s.type === 'array' || s.items !== undefined) && Array.isArray(value)) {
    const items = s.items;
    value.forEach((item, i) => {
      const childPath = joinPath(path, i);
      if (Array.isArray(items)) {
        // 元组形态：越界项不校验（标准行为）
        if (i < items.length) validate(item, items[i], childPath, errors, depth + 1, ctxRoot);
      } else if (items !== undefined) {
        validate(item, items, childPath, errors, depth + 1, ctxRoot);
      }
    });
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      errors.push(`${path || '(root)'}: 数组长度少于 minItems=${s.minItems}`);
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      errors.push(`${path || '(root)'}: 数组长度超过 maxItems=${s.maxItems}`);
    }
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const k = JSON.stringify(item);
        if (seen.has(k)) {
          errors.push(`${path || '(root)'}: 数组元素须唯一（uniqueItems=true）`);
          break;
        }
        seen.add(k);
      }
    }
  }

  // string
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      errors.push(`${path || '(root)'}: 长度少于 minLength=${s.minLength}`);
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      errors.push(`${path || '(root)'}: 长度超过 maxLength=${s.maxLength}`);
    }
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value)) {
          errors.push(`${path || '(root)'}: 不匹配 pattern "${s.pattern}"`);
        }
      } catch {
        // 非法正则：忽略（不因 schema 作者错误误杀合法值）
      }
    }
  }

  // number
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      errors.push(`${path || '(root)'}: 小于 minimum=${s.minimum}`);
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      errors.push(`${path || '(root)'}: 大于 maximum=${s.maximum}`);
    }
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) {
      errors.push(`${path || '(root)'}: 须大于 exclusiveMinimum=${s.exclusiveMinimum}`);
    }
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) {
      errors.push(`${path || '(root)'}: 须小于 exclusiveMaximum=${s.exclusiveMaximum}`);
    }
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
      const q = value / s.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) {
        errors.push(`${path || '(root)'}: 不是 multipleOf=${s.multipleOf} 的整数倍`);
      }
    }
  }
}

/**
 * 校验 value 是否符合 schema（JSON-Schema 子集，见模块头注释）。
 * 永不抛异常：schema 非法 / 值无法序列化均按「不通过 + 错误信息」或「忽略关键字」处理。
 */
export function validateAgainstSchema(value: unknown, schema: unknown): SchemaValidation {
  const errors: string[] = [];
  try {
    validate(value, schema, '', errors, 0);
  } catch (e) {
    // 校验器自身异常：按「无法校验」失败处理，不静默放行（fail-closed）
    errors.push(`(root): 校验器异常：${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: errors.length === 0, errors };
}
