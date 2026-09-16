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
    // allowNavigation 白名单：Capacitor Android 的 Bridge.launchIntent()（所有
    // shouldOverrideUrlLoading 跳转都走这里）会拦截 app 域与白名单外的导航，
    // 触发 Intent.ACTION_VIEW 把页面甩到系统外部浏览器（Chrome）——cookie 存储
    // 是隔离的，外部浏览器里拿不到 WebView 内 Set-Cookie 的 ah_oauth_state，
    // GitHub/Google OAuth 回调就会报「OAuth state 校验失败（CSRF/过期）」。
    // 因此必须把第三方授权页域（github.com / accounts.google.com）加入白名单，
    // 让整条 OAuth 链路（授权 → 登录 → 回跳 callback）都留在 APP 的 WebView 内完成，
    // 同一 cookie 存储里 state cookie 才能被回调请求读到。
    // 注意：allowNavigation 是精确主机匹配（HostMask），需列出授权页实际会访问的域；
    // 若日后新增其他第三方登录，须同步扩展此列表。
    allowNavigation: [
      'agent-harness-86h5.onrender.com',
      'github.com',
      'accounts.google.com'
    ]
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
