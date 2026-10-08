import jue from '@/sdk/jue/2.10.0';

// 违规：iOS 需 jue ≥ 2.25.0，当前 2.10.0（应被 no-system-getsysteminfo 命中）
export function readSystemInfo() {
  if (isIOS) {
    return jue.system.getSystemInfo();
  }
  return null;
}

// 违规：iOS 需 jue ≥ 2.30.0，当前 2.10.0（应被 no-system-getappversion 命中）
export function appVersion() {
  if (isIOS) {
    return jue.system.getAppVersion();
  }
  return '';
}
