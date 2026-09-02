/**
 * 登录 / 注册 / 改密的表单校验规则（前端权威）
 * ----------------------------------------------------------------
 * 需求：把登录与注册的校验从后端前移到前端 —— 用户敲完就立刻得到反馈，
 * 不必等一次网络往返。规则与服务端 `access/server/src/accounts.ts` 逐条对齐
 * （服务端保留同样的校验作为纵深防御，口径一致，不会出现「前端说不合法、
 * 后端却放行」或反之）。
 *
 * ⚠️ 修改本文件时请同步 accounts.ts 的 validUsername / registerUser /
 *    changePassword，两处规则必须保持一致。
 *
 * 校验函数一律返回 `string | null`：null = 通过，字符串 = 给用户的提示文案
 * （已是可直接展示的中文，调用方直接用 notification 弹出即可）。
 */

/** 密码最小长度（与后端 `password.length < 8` 一致）。 */
export const PASSWORD_MIN = 8;
/** 用户名长度区间（与后端 validUsername 一致）。 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

/** 用户名规则：3-32 位字母 / 数字 / 下划线（与后端一致）。 */
export const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
/** 邮箱规则：与后端 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` 一致。 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 校验用户名，通过返回 null。 */
export function validateUsername(value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return '请填写用户名。';
  if (v.length < USERNAME_MIN || v.length > USERNAME_MAX)
    return `用户名需为 ${USERNAME_MIN}-${USERNAME_MAX} 位。`;
  if (!USERNAME_RE.test(v)) return '用户名只能包含字母、数字和下划线。';
  return null;
}

/** 校验邮箱，通过返回 null。注册时邮箱必填（表单首要登录标识）。 */
export function validateEmail(value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return '请填写邮箱。';
  if (!EMAIL_RE.test(v)) return '邮箱格式不正确。';
  return null;
}

/**
 * 校验密码。
 * @param required 登录场景只需「非空」；注册 / 改密场景要求满足强度规则。
 */
export function validatePassword(value: string, required = true): string | null {
  const v = value ?? '';
  if (!v) return '请填写密码。';
  if (required && v.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位。`;
  return null;
}

/** 校验两次输入的密码一致，通过返回 null。 */
export function validateConfirm(password: string, confirm: string): string | null {
  if (!confirm) return '请再次输入密码。';
  if (password !== confirm) return '两次输入的密码不一致。';
  return null;
}

/** 登录表单字段。 */
export interface LoginForm {
  username: string;
  password: string;
}

/**
 * 登录校验：返回第一个不通过字段的提示（null = 全部通过）。
 * 登录只需「必填 + 用户名格式」，凭据正确性仍由服务端判定（前端无从得知）。
 */
export function validateLogin(form: LoginForm): string | null {
  return validateUsername(form.username) ?? validatePassword(form.password, false);
}

/** 注册表单字段。 */
export interface RegisterForm {
  email: string;
  username: string;
  password: string;
  confirm: string;
  /** 是否同意服务条款与隐私政策。 */
  agree: boolean;
}

/** 注册校验：返回第一个不通过字段的提示（null = 全部通过）。 */
export function validateRegister(form: RegisterForm): string | null {
  if (!form.agree) return '请先阅读并同意服务条款与隐私政策。';
  return (
    validateEmail(form.email) ??
    validateUsername(form.username) ??
    validatePassword(form.password) ??
    validateConfirm(form.password, form.confirm)
  );
}

/** 改密表单字段。 */
export interface ChangePasswordForm {
  oldPassword: string;
  newPassword: string;
  confirm: string;
}

/** 改密校验：返回第一个不通过字段的提示（null = 全部通过）。 */
export function validateChangePassword(form: ChangePasswordForm): string | null {
  if (!form.oldPassword) return '请填写当前密码。';
  const pwdErr = validatePassword(form.newPassword);
  if (pwdErr) return pwdErr;
  if (form.oldPassword === form.newPassword)
    return '新密码不能与当前密码相同。';
  return validateConfirm(form.newPassword, form.confirm);
}

/** 申请重置密码表单字段。 */
export interface ForgotForm {
  identifier: string;
}

/**
 * 申请重置密码校验：用户名或注册邮箱其一合法即可（与后端 requestPasswordReset 对齐）。
 * 通过返回 null。
 */
export function validateForgot(form: ForgotForm): string | null {
  const v = (form.identifier ?? '').trim();
  if (!v) return '请填写用户名或邮箱。';
  const isEmail = EMAIL_RE.test(v);
  const isUser = USERNAME_RE.test(v);
  if (!isEmail && !isUser) return '请输入有效的用户名或邮箱。';
  return null;
}

/** 重置密码表单字段（无需旧密码，凭重置凭证）。 */
export interface ResetForm {
  newPassword: string;
  confirm: string;
}

/** 重置密码校验：返回第一个不通过字段的提示（null = 全部通过）。 */
export function validateResetPassword(form: ResetForm): string | null {
  const pwdErr = validatePassword(form.newPassword);
  if (pwdErr) return pwdErr;
  return validateConfirm(form.newPassword, form.confirm);
}
