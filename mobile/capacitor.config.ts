import type { CapacitorConfig } from '@capacitor/cli';

declare const process: { env: Record<string, string | undefined> };

const config: CapacitorConfig = {
  appId: 'com.agentharness.mobile',
  appName: 'Agent Harness',
  webDir: '../frontend/webapp/dist',
  server: {
    // 生产环境 API 地址（由部署时环境变量覆盖）
    url: process.env.AH_API_URL || 'http://localhost:4173',
    androidScheme: 'https',
    iosScheme: 'https',
    // 允许 WebView 加载本地文件
    allowNavigation: ['localhost', '127.0.0.1']
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    },
    // 生物认证配置（iOS Face ID 必须）
    BiometricAuth: {
      faceIDReason: '验证身份以快速登录'
    }
  },
  // iOS 特定配置
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#1a1a1a',
    preferredContentMode: 'mobile'
  },
  // Android 特定配置
  android: {
    backgroundColor: '#1a1a1a',
    allowMixedContent: false
  }
};

export default config;
