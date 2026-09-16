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
    },
    SplashScreen: {
      // 冷启动时显示原生启动图（assets/splash_*.png）直到 webview 首帧渲染完成，
      // 避免 render.com 远程加载期间出现的长时间黑屏。
      launchShowDuration: 2000,
      backgroundColor: '#0b0e14',
      androidSplashResourceName: 'splash',
      iosSpinnerColor: '#2997FF'
    }
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0b0e14',
    preferredContentMode: 'mobile'
  },
  android: {
      backgroundColor: '#0b0e14',
      allowMixedContent: false,
      // Android 14+ 强制 edge-to-edge：系统状态栏 / 导航栏区域透出 webview 内容。
      // backgroundColor 兜底：webview 内容未渲染时该区域显示 #0b0e14 而非纯黑。
      webContentsDebuggingEnabled: false
    }
};

export default config;
