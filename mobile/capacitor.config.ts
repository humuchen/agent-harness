import type { CapacitorConfig } from '@capacitor/cli';

declare const process: { env: Record<string, string | undefined> };

const config: CapacitorConfig = {
  appId: 'com.agentharness.mobile',
  appName: 'AgentHarness',
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
    }
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#1a1a1a',
    preferredContentMode: 'mobile'
  },
  android: {
    backgroundColor: '#1a1a1a',
    allowMixedContent: false
  }
};

export default config;
