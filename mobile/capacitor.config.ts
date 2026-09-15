import type { CapacitorConfig } from '@capacitor/cli';

declare const process: { env: Record<string, string | undefined> };

const config: CapacitorConfig = {
  appId: 'com.agentharness.mobile',
  appName: 'Agent Harness',
  webDir: '../frontend/webapp/dist',
  server: {
    url: process.env.AH_API_URL || 'https://agent-harness-86h5.onrender.com',
    androidScheme: 'https',
    iosScheme: 'https',
    allowNavigation: ['agent-harness-86h5.onrender.com']
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    },
    BiometricAuth: {
      faceIDReason: '验证身份以快速登录'
    },
    StatusBar: {
          // style: 'DARK' = 深色背景 + 浅色（白）图标 — 配合深色主题背景 #0b0e14
          // 注意：Android 16+ 忽略 overlaysWebView 和 backgroundColor，改为系统强制 edge-to-edge
          overlaysWebView: true,
          style: 'DARK',
          backgroundColor: '#0b0e14'
        }
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0b0e14',
    preferredContentMode: 'mobile'
  },
  android: {
      backgroundColor: '#0b0e14',
      allowMixedContent: false
    }
};

export default config;