import jue from '@/sdk/jue/2.30.0';

// 合规：版本满足（2.30.0 ≥ 2.25.0），不应被命中
export function readSystemInfo() {
  if (isIOS) {
    return jue.system.getSystemInfo();
  }
  return null;
}

// 合规：iOS 上 connectSocket 不受限（只有鸿蒙不支持）
export function openSocketOnIos() {
  if (isIOS) {
    jue.network.connectSocket({ url: 'wss://example.com' });
  }
}

// 合规：没错的端（connectSocket 只禁鸿蒙，Android 可用）
export function openSocketOnAndroid() {
  if (isAndroid) {
    jue.network.connectSocket({ url: 'wss://example.com' });
  }
}
