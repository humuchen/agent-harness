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
    }
  }
};

export default config;
