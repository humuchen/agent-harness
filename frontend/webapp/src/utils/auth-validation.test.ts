import { describe, it, expect } from 'vitest';
import {
  validateUsername,
  validateEmail,
  validatePassword,
  validateConfirm,
  validateLogin,
  validateRegister,
  validateChangePassword,
  validateForgot,
  validateResetPassword,
  USERNAME_RE
} from './auth-validation';

describe('validateUsername', () => {
  it('空/空白返回提示', () => {
    expect(validateUsername('')).not.toBeNull();
    expect(validateUsername('   ')).not.toBeNull();
  });
  it('长度超出区间返回提示', () => {
    expect(validateUsername('ab')).not.toBeNull();
    expect(validateUsername('a'.repeat(33))).not.toBeNull();
  });
  it('非法字符（含空格/中文）返回提示', () => {
    expect(validateUsername('ab c')).not.toBeNull();
    expect(validateUsername('用户')).not.toBeNull();
  });
  it('合法用户名通过', () => {
    expect(validateUsername('alice_01')).toBeNull();
    expect(USERNAME_RE.test('alice_01')).toBe(true);
  });
});

describe('validateEmail', () => {
  it('空/非法格式返回提示', () => {
    expect(validateEmail('')).not.toBeNull();
    expect(validateEmail('not-an-email')).not.toBeNull();
    expect(validateEmail('a@b')).not.toBeNull();
  });
  it('合法邮箱通过', () => {
    expect(validateEmail('a@b.com')).toBeNull();
  });
});

describe('validatePassword', () => {
  it('空密码返回提示', () => {
    expect(validatePassword('')).not.toBeNull();
    expect(validatePassword('', false)).not.toBeNull();
  });
  it('required=false 时短密码允许（登录仅校验非空）', () => {
    expect(validatePassword('123', false)).toBeNull();
  });
  it('required=true 时短密码返回提示', () => {
    expect(validatePassword('123', true)).not.toBeNull();
    expect(validatePassword('12345678', true)).toBeNull();
  });
});

describe('validateConfirm', () => {
  it('空确认返回提示', () => {
    expect(validateConfirm('a', '')).not.toBeNull();
  });
  it('不一致返回提示', () => {
    expect(validateConfirm('a', 'b')).not.toBeNull();
  });
  it('一致通过', () => {
    expect(validateConfirm('a', 'a')).toBeNull();
  });
});

describe('validateLogin', () => {
  it('完整合法通过', () => {
    expect(validateLogin({ username: 'alice', password: 'x' })).toBeNull();
  });
  it('非法用户名优先报错', () => {
    expect(validateLogin({ username: 'a', password: 'x' })).not.toBeNull();
  });
});

describe('validateRegister', () => {
  it('未勾选条款返回提示', () => {
    expect(
      validateRegister({
        email: 'a@b.com',
        username: 'alice',
        password: '12345678',
        confirm: '12345678',
        agree: false
      })
    ).not.toBeNull();
  });
  it('完整合法通过', () => {
    expect(
      validateRegister({
        email: 'a@b.com',
        username: 'alice',
        password: '12345678',
        confirm: '12345678',
        agree: true
      })
    ).toBeNull();
  });
  it('密码不一致返回提示', () => {
    expect(
      validateRegister({
        email: 'a@b.com',
        username: 'alice',
        password: '12345678',
        confirm: '87654321',
        agree: true
      })
    ).not.toBeNull();
  });
});

describe('validateChangePassword', () => {
  it('新旧密码相同返回提示', () => {
    expect(
      validateChangePassword({ oldPassword: '12345678', newPassword: '12345678', confirm: '12345678' })
    ).not.toBeNull();
  });
  it('合法通过', () => {
    expect(
      validateChangePassword({ oldPassword: 'old12345', newPassword: 'new12345', confirm: 'new12345' })
    ).toBeNull();
  });
});

describe('validateForgot / validateResetPassword', () => {
  it('forgot 接受合法用户名或邮箱', () => {
    expect(validateForgot({ identifier: 'alice' })).toBeNull();
    expect(validateForgot({ identifier: 'a@b.com' })).toBeNull();
  });
  it('forgot 非法标识返回提示', () => {
    expect(validateForgot({ identifier: 'a b' })).not.toBeNull();
  });
  it('reset 合法通过', () => {
    expect(validateResetPassword({ newPassword: '12345678', confirm: '12345678' })).toBeNull();
  });
  it('reset 不一致返回提示', () => {
    expect(validateResetPassword({ newPassword: '12345678', confirm: 'x' })).not.toBeNull();
  });
});
