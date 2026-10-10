"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripDataUrlPrefix = exports.uploadArtifact = exports.notificationController = exports.offlineCacheController = exports.biometricAuthController = exports.fileUploadController = exports.deepLinkController = exports.pushNotificationController = void 0;
/**
 * 移动端入口
 *
 * 启动流程：
 * 1. 注册所有 Capacitor 原生插件
 * 2. 从 Preferences 读取持久化 token（生物认证快捷登录）
 * 3. 引导 WebView 加载 webapp（dist/）
 */
const register_plugins_1 = require("./bridge/register-plugins");
// 注册原生插件
(0, register_plugins_1.registerPlugins)();
// 导出插件（供业务层使用）
var push_notification_1 = require("./plugins/push-notification");
Object.defineProperty(exports, "pushNotificationController", { enumerable: true, get: function () { return push_notification_1.pushNotificationController; } });
var deep_link_1 = require("./plugins/deep-link");
Object.defineProperty(exports, "deepLinkController", { enumerable: true, get: function () { return deep_link_1.deepLinkController; } });
var file_upload_1 = require("./plugins/file-upload");
Object.defineProperty(exports, "fileUploadController", { enumerable: true, get: function () { return file_upload_1.fileUploadController; } });
var biometric_auth_1 = require("./plugins/biometric-auth");
Object.defineProperty(exports, "biometricAuthController", { enumerable: true, get: function () { return biometric_auth_1.biometricAuthController; } });
var offline_cache_1 = require("./plugins/offline-cache");
Object.defineProperty(exports, "offlineCacheController", { enumerable: true, get: function () { return offline_cache_1.offlineCacheController; } });
var local_notification_1 = require("./plugins/local-notification");
Object.defineProperty(exports, "notificationController", { enumerable: true, get: function () { return local_notification_1.notificationController; } });
var artifacts_client_1 = require("./plugins/artifacts-client");
Object.defineProperty(exports, "uploadArtifact", { enumerable: true, get: function () { return artifacts_client_1.uploadArtifact; } });
Object.defineProperty(exports, "stripDataUrlPrefix", { enumerable: true, get: function () { return artifacts_client_1.stripDataUrlPrefix; } });
