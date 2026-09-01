import { objectParams, ToolRegistry } from '../tools';

type NumTok = { t: 'num'; v: number };
type IdTok = { t: 'id'; v: string };
type OpTok = { t: 'op'; v: string };
type LpTok = { t: 'lp' };
type RpTok = { t: 'rp' };
type Tok = NumTok | IdTok | OpTok | LpTok | RpTok;

const FUNCS: Record<string, { fn: (...a: number[]) => number; arity: number }> = {
  sqrt: { fn: Math.sqrt, arity: 1 },
  abs: { fn: Math.abs, arity: 1 },
  floor: { fn: Math.floor, arity: 1 },
  ceil: { fn: Math.ceil, arity: 1 },
  round: { fn: Math.round, arity: 1 },
  exp: { fn: Math.exp, arity: 1 },
  ln: { fn: Math.log, arity: 1 },
  log: { fn: Math.log10, arity: 1 },
  sin: { fn: Math.sin, arity: 1 },
  cos: { fn: Math.cos, arity: 1 },
  tan: { fn: Math.tan, arity: 1 },
  pow: { fn: Math.pow, arity: 2 },
  atan2: { fn: Math.atan2, arity: 2 },
  min: { fn: (a: number, b: number) => Math.min(a, b), arity: 2 },
  max: { fn: (a: number, b: number) => Math.max(a, b), arity: 2 },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** 词法分析：数字 / 标识符 / 运算符 / 括号 / 逗号。 */
function tokenize(s: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  const isAlpha = (c: string | undefined) =>
    c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && i + 1 < s.length && isDigit(s[i + 1]))) {
      let j = i;
      let seenDot = false;
      while (j < s.length && (isDigit(s[j]) || (s[j] === '.' && !seenDot))) {
        if (s[j] === '.') seenDot = true;
        j++;
      }
      tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (isAlpha(c)) {
      let j = i;
      while (j < s.length && (isAlpha(s[j]) || isDigit(s[j]))) j++;
      tokens.push({ t: 'id', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '^') {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'lp' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'rp' });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ t: 'op', v: ',' });
      i++;
      continue;
    }
    throw new Error(`unexpected character '${c}'`);
  }
  return tokens;
}

/** 把「运算符前的减号」标记为一元负号（u-），以正确解析 -3^2、2*-3 等。 */
function markUnary(tokens: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const tok of tokens) {
    if (tok.t === 'op' && tok.v === '-') {
      const prev = out[out.length - 1];
      const unary = !prev || prev.t === 'op' || prev.t === 'lp';
      if (unary) {
        out.push({ t: 'op', v: 'u-' });
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}

function prec(op: string): number {
  switch (op) {
    case '+':
    case '-':
      return 1;
    case '*':
    case '/':
    case '%':
      return 2;
    case '^':
      return 3;
    case 'u-':
      return 4;
    default:
      return 0;
  }
}

/** 调度场算法（shunting-yard）转为逆波兰式（RPN）。 */
function toRPN(tokens: Tok[]): Tok[] {
  const out: Tok[] = [];
  const stack: Tok[] = [];
  for (const tok of tokens) {
    if (tok.t === 'num') {
      out.push(tok);
    } else if (tok.t === 'id') {
      const constantVal = CONSTANTS[tok.v];
      if (constantVal !== undefined) out.push({ t: 'num', v: constantVal });
      else if (FUNCS[tok.v]) stack.push(tok);
      else throw new Error(`unknown function or constant '${tok.v}'`);
    } else if (tok.t === 'lp') {
      stack.push(tok);
    } else if (tok.t === 'rp') {
      while (stack.length && stack[stack.length - 1]?.t !== 'lp') out.push(stack.pop() as Tok);
      if (stack.length && stack[stack.length - 1]?.t === 'lp') stack.pop();
      if (stack.length && stack[stack.length - 1]?.t === 'id') out.push(stack.pop() as Tok);
    } else if (tok.t === 'op') {
      if (tok.v === ',') {
        while (stack.length && stack[stack.length - 1]?.t !== 'lp') out.push(stack.pop() as Tok);
      } else {
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (!top || top.t === 'lp' || top.t === 'id') break;
          if (top.t !== 'op') break;
          const topPrec = prec((top as OpTok).v);
          const tokPrec = prec(tok.v);
          const rightAssoc = tok.v === '^' || tok.v === 'u-';
          if (topPrec > tokPrec || (topPrec === tokPrec && !rightAssoc)) {
            out.push(stack.pop() as Tok);
          } else break;
        }
        stack.push(tok);
      }
    }
  }
  while (stack.length) {
    const t = stack.pop() as Tok;
    if (t.t === 'lp') throw new Error('mismatched parentheses');
    out.push(t);
  }
  return out;
}

/** 在 RPN 上求值。 */
function evalRPN(rpn: Tok[]): number {
  const st: number[] = [];
  for (const tok of rpn) {
    if (tok.t === 'num') {
      st.push(tok.v);
    } else if (tok.t === 'op') {
      if (tok.v === 'u-') {
        const a = st.pop();
        if (a === undefined) throw new Error('invalid expression');
        st.push(-a);
      } else {
        const b = st.pop();
        const a = st.pop();
        if (a === undefined || b === undefined) throw new Error('invalid expression');
        switch (tok.v) {
          case '+':
            st.push(a + b);
            break;
          case '-':
            st.push(a - b);
            break;
          case '*':
            st.push(a * b);
            break;
          case '/':
            if (b === 0) throw new Error('division by zero');
            st.push(a / b);
            break;
          case '%':
            st.push(a % b);
            break;
          case '^':
            st.push(Math.pow(a, b));
            break;
          default:
            throw new Error(`unknown operator ${tok.v}`);
        }
      }
    } else if (tok.t === 'id') {
      const f = FUNCS[tok.v];
      if (!f) throw new Error(`unknown function ${tok.v}`);
      const args: number[] = [];
      for (let k = 0; k < f.arity; k++) {
        const a = st.pop();
        if (a === undefined) throw new Error(`not enough arguments for ${tok.v}`);
        args.unshift(a);
      }
      st.push(f.fn(...args));
    }
  }
  if (st.length !== 1) throw new Error('invalid expression');
  const result = st[0];
  if (result === undefined) throw new Error('invalid expression');
  return result;
}

/** 安全求值数学表达式（绝不执行任意代码）。返回数值；非法输入抛错。 */
export function evaluateExpression(expr: string): number {
  if (!expr || !expr.trim()) throw new Error('empty expression');
  return evalRPN(toRPN(markUnary(tokenize(expr))));
}

export function registerCalculator(registry: ToolRegistry): void {
  registry.register(
    'builtin__calculator',
    'Evaluate a mathematical expression safely (no code execution). Supports + - * / % ^, ' +
      'parentheses, unary minus, constants pi/e, and functions: sqrt, abs, floor, ceil, round, ' +
      'exp, ln, log (base-10), sin, cos, tan, pow, atan2, min, max. ' +
      'Example: "pow(2,10) + sqrt(16) - 3.5".',
    objectParams(
      { expression: { type: 'string', description: 'The mathematical expression to evaluate.' } },
      ['expression']
    ),
    async (args: Record<string, unknown>) => {
      const expr = String(args.expression ?? '');
      try {
        const result = evaluateExpression(expr);
        if (!Number.isFinite(result)) return `error: result is not finite (${result})`;
        return String(result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );
}
