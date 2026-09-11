/**
 * 技能注册表（P2-Skills）。
 *
 * 提供企业 Agent 平台的「技能目录」数据，供前端「技能管理」面板枚举、启停技能，
 * 后端路由（后续集成）据此控制技能是否对外可用。
 *
 * 设计：与本项目一贯的「接口 + 默认实现 + 组合工厂」一致——
 * - `SkillRegistry` 是契约（list / get / setEnabled）；
 * - 默认实现 `FileSkillRegistry` 从 `SKILL_REGISTRY_FILE`（JSON）读写，便于持久化启停状态；
 * - 文件缺失时 SEED 一组内置示例技能并持久化，保证端点始终有可演示数据；
 * - 后续可新增 `DbSkillRegistry` / `RemoteSkillRegistry` 实现同一接口，业务层零改动。
 *
 * 数据写入（启停）落盘，端点 `GET /api/skills` 与 `POST /api/skills/:id/enable|disable` 受保护。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: string;
}

export interface SkillRegistry {
  list(): Promise<SkillDef[]>;
  get(id: string): Promise<SkillDef | null>;
  setEnabled(id: string, enabled: boolean): Promise<SkillDef | null>;
}

// ── 内置种子技能：文件缺失时首次落盘，保证端点始终有可演示数据 ──
const DEFAULT_SKILLS: SkillDef[] = [
  {
    id: 'doc-gen',
    name: '文档生成',
    description: '根据提示词自动生成结构化文档（周报 / 方案 / 操作手册）。',
    enabled: true,
    source: 'builtin'
  },
  {
    id: 'data-export',
    name: '数据导出',
    description: '将对话记录 / 业务数据导出为 CSV 或 Excel 文件。',
    enabled: true,
    source: 'builtin'
  },
  {
    id: 'code-review',
    name: '代码审查',
    description: '对 Pull Request 进行自动化代码审查、风格与安全扫描。',
    enabled: false,
    source: 'enterprise'
  },
  {
    id: 'summarize',
    name: '内容摘要',
    description: '对长文档 / 会议录音转写做多语言摘要与要点抽取。',
    enabled: true,
    source: 'builtin'
  }
];

export class FileSkillRegistry implements SkillRegistry {
  private readonly file: string;

  constructor(file: string | undefined) {
    this.file = file && file.length > 0 ? file : '.data/skills.json';
  }

  /** 读取技能列表；文件缺失 / 损坏 / 非法时 SEED 默认并持久化。 */
  async list(): Promise<SkillDef[]> {
    if (this.file && existsSync(this.file)) {
      try {
        const raw = await readFile(this.file, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed as SkillDef[];
        }
      } catch {
        // 损坏 / 解析失败：回落种子并覆盖持久化，避免端点 5xx。
      }
    }
    const seeded = DEFAULT_SKILLS.map((s) => ({ ...s }));
    await this.save(seeded);
    return seeded;
  }

  async get(id: string): Promise<SkillDef | null> {
    const items = await this.list();
    return items.find((s) => s.id === id) ?? null;
  }

  /** 更新某技能启停状态并落盘；未知 id 返回 null。 */
  async setEnabled(id: string, enabled: boolean): Promise<SkillDef | null> {
    const items = await this.list();
    const target = items.find((s) => s.id === id);
    if (!target) return null;
    target.enabled = enabled;
    await this.save(items);
    return { ...target };
  }

  private async save(items: SkillDef[]): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(items, null, 2), 'utf-8');
  }
}

let registrySingleton: SkillRegistry | null = null;

/** 组合工厂：按环境变量选择 registry（默认文件 → 种子）。 */
export function getSkillRegistry(env: NodeJS.ProcessEnv = process.env): SkillRegistry {
  if (!registrySingleton) {
    registrySingleton = new FileSkillRegistry(env.SKILL_REGISTRY_FILE || undefined);
  }
  return registrySingleton;
}

/** 供测试注入自定义 registry。 */
export function setSkillRegistry(r: SkillRegistry | null): void {
  registrySingleton = r;
}
