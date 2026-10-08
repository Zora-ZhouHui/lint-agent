import jue from '@/sdk/jue/2.10.0';

// 违规：connectSocket 在鸿蒙 ArkTS 不支持（应被 no-network-connectsocket-on-harmony 命中）
export function openSocket() {
  if (isHarmony) {
    jue.network.connectSocket({ url: 'wss://example.com' });
  }
}

// 违规：getBatteryInfo 在鸿蒙不支持（应被 no-system-getbatteryinfo 命中）
export function batteryInfo() {
  if (isHarmony) {
    return jue.system.getBatteryInfo();
  }
  return null;
}
