# App Store / Play 审核材料

## 1. 基本信息

| 项目 | 内容 |
|---|---|
| **App ID** | `com.agentharness.mobile` |
| **App 名称** | Agent Harness |
| **副标题** | AI Agent 工作台 |
| **版本** | 1.0.0 |
| **Bundle ID** | com.agentharness.mobile |
| **分类** | 效率 / 商务 |
| **最低系统** | iOS 15.0+ / Android 12+ |
| **深色模式** | 支持 |

## 2. 隐私政策

### 2.1 数据收集

| 数据类型 | 用途 | 是否必需 |
|---|---|---|
| 设备令牌 (FCM/APNs) | 推送通知 | 可选 |
| 生物认证 (Face ID/Touch ID) | 快捷登录 | 可选 |
| 相机/相册 | 上传成果物附件 | 可选 |
| 网络状态 | 离线缓存策略 | 自动 |

### 2.2 数据存储

- **token**：存 iOS Keychain / Android EncryptedSharedPreferences（生物认证保护）
- **缓存**：存 @capacitor/preferences（应用沙盒内）
- **服务器数据**：通过 HTTPS 与后端 API 通信，不在本地持久化

### 2.3 第三方服务

| 服务 | 用途 | 隐私政策 |
|---|---|---|
| Firebase Cloud Messaging (FCM) | Android 推送 | https://firebase.google.com/support/privacy |
| Apple Push Notification Service (APNs) | iOS 推送 | https://apple.com/privacy |

## 3. App Store 审核要点

### 3.1 功能描述

> Agent Harness 是一款 AI Agent 控制台移动端应用。用户可以通过手机管理对话会话、查看工作流执行状态、审批任务、上传文件到成果物档案库，并接收实时推送通知。

### 3.2 关键功能清单

- [x] 对话会话管理（查看、创建、删除）
- [x] 工作流执行监控
- [x] 审批任务处理
- [x] 成果物档案库（上传、浏览、下载）
- [x] 实时推送通知
- [x] 生物认证快捷登录
- [x] 离线缓存（弱网只读）
- [x] Deep Link 唤起指定视图

### 3.3 权限申请说明

| 权限 | 用途描述 |
|---|---|
| `NSFaceIDUsageDescription` | 使用 Face ID 快速登录，无需输入密码 |
| `NSCameraUsageDescription` | 拍照上传为成果物附件 |
| `NSPhotoLibraryUsageDescription` | 从相册选择图片上传为成果物附件 |
| `NSPhotoLibraryAddUsageDescription` | 保存成果物到相册 |

### 3.4 审核注意事项

1. **AI 代理类 App**：需在审核备注中说明"本应用为 AI Agent 控制台，不生成内容，仅展示和管理用户主动触发的 Agent 任务"
2. **推送通知**：首次启动时弹出权限请求，不强制要求
3. **生物认证**：提供"跳过"选项，不强制使用 Face ID
4. **账户系统**：如使用账户密码登录，需提供测试账号给审核人员

## 4. Google Play 审核要点

### 4.1 目标 API 级别

- `targetSdkVersion`: 34 (Android 14)
- `minSdkVersion`: 31 (Android 12)

### 4.2 权限清单

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.USE_BIOMETRIC" />
<uses-permission android:name="android.permission.USE_FINGERPRINT" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

### 4.3 数据安全表单

| 问题 | 回答 |
|---|---|
| 是否收集个人数据？ | 是（用户名、设备令牌） |
| 是否共享数据？ | 否 |
| 是否加密传输？ | 是（HTTPS） |
| 是否有数据删除机制？ | 是（账户删除端点） |

## 5. Deep Link 路由表

| Deep Link | 目标视图 | 说明 |
|---|---|---|
| `piagent://chat` | 对话 Tab | 打开对话列表 |
| `piagent://chat/:sessionId` | 对话详情 | 打开指定会话 |
| `piagent://plan` | 计划 Tab | 打开计划看板 |
| `piagent://plan/:planId` | 计划详情 | 打开指定计划 |
| `piagent://artifact` | 档案 Tab | 打开成果物库 |
| `piagent://settings` | 设置 Tab | 打开设置页 |

## 6. 构建与发布流程

### 6.1 iOS (App Store)

```bash
# 1. 构建 webapp + 同步到原生项目
pnpm --filter @agent-harness/mobile run build

# 2. 安装依赖（需要 CocoaPods）
cd ios/App && pod install && cd ../..

# 3. 打开 Xcode
pnpm --filter @agent-harness/mobile run open:ios

# 4. Xcode 中：Product → Archive → Distribute App
```

### 6.2 Android (Google Play)

```bash
# 1. 构建 webapp + 同步到原生项目
pnpm --filter @agent-harness/mobile run build

# 2. 打开 Android Studio
pnpm --filter @agent-harness/mobile run open:android

# 3. Android Studio 中：Build → Generate Signed Bundle / APK
```

### 6.3 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `AH_API_URL` | 后端 API 地址 | `http://localhost:4173` |
| `AH_API_TARGET` | Vite dev proxy 目标 | `http://localhost:4173` |
