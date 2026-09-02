/**
 * 通用 UI 组件统一注册入口（components/ 目录的「公共原语」）。
 *
 * 把散落在 main.ts 各处的通用 UI 组件（弹层 / 弹框 / 抽屉）集中在此一次性注册，
 * main.ts 只需 import 本文件即可拿到全部通用原语，避免各处重复引入、注册点分散。
 *
 * 约定：本文件只负责「副作用注册自定义元素」，不导出任何组件类；如各业务模块
 * 需要引用组件类型（如 AhModal），仍各自从对应文件 import 即可。
 * 仅纳入真正通用的 UI 原语；业务/特性组件（如各类 picker、file-upload、suggestions）
 * 仍由各特性模块就近引入。
 */
// 弹层/模态（历史保留，计划下个迭代删除，详见 ah-popup.ts 顶部说明）。
import './ah-popup';
// 统一弹框组件：info / confirm / warning / 自定义内容 + 命令式 API。
import './ah-modal';
// 通用抽屉组件：四向滑入 + 遮罩/ Esc / 关闭按钮 + 焦点圈闭环。
import './ah-drawer';
// 全局通知组件：全站「接口错误 / 操作结果」提示的唯一出口（notify.* 命令式 API）。
import './ah-notification';
// 顶栏用户菜单（头像 + 下拉：用户·角色 / 修改密码 / 退出登录）。
import './user-menu';
