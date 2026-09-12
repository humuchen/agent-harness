import type { CapacitorConfig } from '@capacitor/cli';

declare const process: { env: Record<string, string | undefined> };

const config: CapacitorConfig = {
  appId: 'com.agentharness.mobile',
  appName: 'Agent Harness',
  webDir: '../frontend/webapp/dist',
  server: {
    // 开发环境：指向本机局域网 IP（手机通过 WiFi 访问）
    // 生产环境：由 AH_API_URL 环境变量覆盖
    url: process.env.AH_API_URL || 'http://192.168.31.48:4173',
    androidScheme: 'http',
    iosScheme: 'https',
    allowNavigation: ['localhost', '127.0.0.1', '192.168.31.48']
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    },
    BiometricAuth: {
      faceIDReason: '验证身份以快速登录'
    }
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#1a1a1a',
    preferredContentMode: 'mobile'
  },
  android: {
    backgroundColor: '#1a1a1a',
    allowMixedContent: true
  }
};

export default config;
