# 跨端文档差异总结（jue SDK 约束样例）

> 本文件为 jue SDK 跨端一致性约束的输入样例，共 100 条，按功能场景分组。
>
> **约定：**
>
> - `jue` 为 SDK 名；`jue.xxx` 指挂载在 jue 之上的方法 / 命名空间 / 属性（含 `jue.module.method` 多层挂载）。
> - **版本来源**：`import jue from '.../jue/<版本>'` 中 import 路径末尾的目录名，即 jue 版本。
> - **平台来源**：通过 `if (isIOS)` / `if (isAndroid)` 这类运行时注入变量守卫推断；仅当调用落在平台守卫闭包内才可确定平台。
> - **校验级别**：
>   - `[硬校验]`：平台与版本均可确定 → 违规报错（error）。
>   - `[提示]`：平台不确定 → 降级为提示（warning），不阻断。
>   - `[跳过]`：无法静态检测的语义模式 → 不校验，仅留档说明。
> - 文中 `jue ≥ X.Y.Z` 均使用同一套 jue 公共版本号空间；API 名称为示例占位，可替换为真实 jue API 清单。

## 场景一：jue 系统能力（1–12）

### 1. jue.system.getSystemInfo [硬校验]

iOS 需 jue ≥ 2.25.0，Android 需 jue ≥ 2.10.0。低于阈值改用静态字段兜底。

### 2. jue.system.getPlatform [硬校验]

所有端 jue ≥ 2.0.0 才支持。更早版本须用注入的 isIOS / isAndroid 标志判断。

### 3. jue.system.getAppVersion [硬校验]

iOS 需 jue ≥ 2.30.0，Android 需 jue ≥ 2.15.0。低于阈值从打包配置读取。

### 4. jue.system.getSDKVersion [硬校验]

所有端 jue ≥ 2.20.0 才支持。用于特性探测替代。

### 5. jue.system.getBatteryInfo [硬校验]

鸿蒙 ArkTS 不支持。改用自定义原生桥接，或仅提示。

### 6. jue.system.getBatteryInfoSync [硬校验]

iOS 需 jue ≥ 2.40.0，Android 需 jue ≥ 2.35.0。低于阈值走异步版本。

### 7. jue.system.vibrate [硬校验]

鸿蒙部分机型不支持。做能力探测后降级为忽略。

### 8. jue.system.getNetworkType [硬校验]

所有端 jue ≥ 2.5.0 才支持。更早版本改用 jue.network.getNetworkType。

### 9. jue.system.scanCode [硬校验]

iOS 需 jue ≥ 2.45.0，Android 需 jue ≥ 2.32.0。低于阈值禁用入口或提示升级。

### 10. jue.system.getClipboard [提示]

旧接口已废弃，平台差异不确定，仅提示迁移到 jue.clipboard.getClipboardData。

### 11. jue.system.getMemoryInfo [提示]

平台返回字段不一致，仅提示按端分支处理。

### 12. jue.system.onMemoryWarning [提示]

触达时机跨端不可预测，仅提示做降级释放逻辑。

## 场景二：jue 设备（13–22）

### 13. jue.device.getDeviceId [硬校验]

iOS 需 jue ≥ 2.28.0，Android 需 jue ≥ 2.12.0。低于阈值改用服务端下发匿名 ID。

### 14. jue.device.getModel [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 15. jue.device.getScreenWidth [硬校验]

iOS 需 jue ≥ 2.10.0，Android 需 jue ≥ 2.8.0。低于阈值从布局层获取。

### 16. jue.device.getScreenHeight [硬校验]

iOS 需 jue ≥ 2.10.0，Android 需 jue ≥ 2.8.0。低于阈值从布局层获取。

### 17. jue.device.getOrientation [硬校验]

鸿蒙 ArkTS 不支持。改用 jue.device.onOrientationChange 或 UI 自适应。

### 18. jue.device.onOrientationChange [提示]

事件触发语义跨端不一致，仅提示做防抖与去重。

### 19. jue.device.getSystemLanguage [硬校验]

iOS 需 jue ≥ 2.22.0，Android 需 jue ≥ 2.16.0。低于阈值从本地缓存读取用户设定。

### 20. jue.device.getDeviceInfo [硬校验]

所有端 jue ≥ 2.30.0 才支持。合并式设备信息，低于阈值逐字段获取。

### 21. jue.device.setKeepScreenOn [硬校验]

iOS 需 jue ≥ 2.50.0，Android 需 jue ≥ 2.42.0。低于阈值不调用并提示。

### 22. jue.device.getIdfv [提示]

iOS 专属标识，其它端无等价物，仅提示走平台分支。

## 场景三：jue 网络（23–34）

### 23. jue.network.request [硬校验]

所有端 jue ≥ 2.0.0 才支持。统一网络请求入口。

### 24. jue.network.get [硬校验]

所有端 jue ≥ 2.5.0 才支持。更早版本用 request 指定 method。

### 25. jue.network.post [硬校验]

所有端 jue ≥ 2.5.0 才支持。更早版本用 request 指定 method。

### 26. jue.network.uploadFile [硬校验]

iOS 需 jue ≥ 2.30.0，Android 需 jue ≥ 2.18.0。低于阈值禁用上传或走 request 分包。

### 27. jue.network.downloadFile [硬校验]

iOS 需 jue ≥ 2.30.0，Android 需 jue ≥ 2.18.0。低于阈值禁用下载。

### 28. jue.network.connectSocket [硬校验]

鸿蒙 ArkTS 不支持。改用轮询或第三方长连接 SDK。

### 29. jue.network.sendSocketMessage [硬校验]

鸿蒙 ArkTS 不支持。与 connectSocket 成对禁用。

### 30. jue.network.onSocketMessage [提示]

回调触达频率跨端不一致，仅提示合并处理。

### 31. jue.network.getNetworkType [硬校验]

所有端 jue ≥ 2.5.0 才支持。与 jue.system.getNetworkType 二选一，避免重复。

### 32. jue.network 定时轮询请求 [跳过]

涉及运行时循环语义，无法静态检测；核心路径须统一 supervisable 轮询器。

### 33. jue.network.request 并发上限控制 [跳过]

属于业务并发策略，无法用 selector 检测；统一封装到 SDK 内。

### 34. jue.network.cancelAll [提示]

平台支持不完整，仅提示按端实现取消机制。

## 场景四：jue 存储（35–42）

### 35. jue.storage.set [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 36. jue.storage.get [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 37. jue.storage.remove [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 38. jue.storage.setSync [硬校验]

iOS 需 jue ≥ 2.12.0，Android 需 jue ≥ 2.10.0。低于阈值改用异步 set。

### 39. jue.storage.getSync [硬校验]

iOS 需 jue ≥ 2.12.0，Android 需 jue ≥ 2.10.0。低于阈值改用异步 get。

### 40. jue.storage.getStorageInfo [硬校验]

鸿蒙 ArkTS 不支持。低于阈值自行统计占用。

### 41. jue.storage.clear 全量清空 [提示]

清空范围跨端语义不同，仅提示二次确认。

### 42. jue.storage 持久化 BigInt [跳过]

BigInt 无法序列化，所有端禁止；改字符串传输（属硬约束，但需运行时类型检测，仅留档）。

## 场景五：jue 界面交互（43–52）

### 43. jue.ui.toast [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 44. jue.ui.showLoading [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 45. jue.ui.hideLoading [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 46. jue.ui.showModal [硬校验]

iOS 需 jue ≥ 2.15.0，Android 需 jue ≥ 2.8.0。低于阈值用 toast 替代。

### 47. jue.ui.showActionSheet [硬校验]

iOS 需 jue ≥ 2.15.0，Android 需 jue ≥ 2.8.0。低于阈值禁用。

### 48. jue.ui.setNavigationBarTitle [硬校验]

鸿蒙 ArkUI 不支持，须用自定义标题栏组件。

### 49. jue.ui.showTabBar [硬校验]

iOS 需 jue ≥ 2.35.0，Android 需 jue ≥ 2.30.0。低于阈值隐藏入口。

### 50. jue.ui.animateTo [提示]

动画参数跨端兼容性不确定，仅提示做降级。

### 51. jue.ui.getBoundingClientRect [跳过]

依赖运行时布局结果，无法静态检测。

### 52. jue.ui 自定义组件 ref 调用 [提示]

ref 挂载时机跨端不一致，仅提示判空后再调。

## 场景六：jue 路由（53–60）

### 53. jue.router.navigateTo [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 54. jue.router.redirectTo [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 55. jue.router.navigateBack [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 56. jue.router.switchTab [硬校验]

iOS 需 jue ≥ 2.20.0，Android 需 jue ≥ 2.15.0。低于阈值禁用 tab 切换。

### 57. jue.router.reLaunch [硬校验]

iOS 需 jue ≥ 2.20.0，Android 需 jue ≥ 2.15.0。低于阈值用 navigateBack 循环返回。

### 58. jue.router.getRoutes [提示]

返回结构跨端不一致，仅提示做类型断言。

### 59. jue.router 动态拼接路由路径 [跳过]

路径须静态可分析，禁止运行时变量拼接（属语义约束，仅留档）。

### 60. jue.router.preNavigate [提示]

预加载能力平台不确定，仅提示做开关。

## 场景七：jue 媒体（61–68）

### 61. jue.media.chooseImage [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 62. jue.media.previewImage [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 63. jue.media.saveImage [硬校验]

iOS 需 jue ≥ 2.25.0，Android 需 jue ≥ 2.10.0。低于阈值禁用保存。

### 64. jue.media.getRecorder [硬校验]

鸿蒙 ArkTS 不支持。改用自带录音权限流程。

### 65. jue.media.playVoice [硬校验]

iOS 需 jue ≥ 2.40.0，Android 需 jue ≥ 2.35.0。低于阈值用 H5 audio 兜底。

### 66. jue.media.chooseVideo [硬校验]

iOS 需 jue ≥ 2.45.0，Android 需 jue ≥ 2.40.0。低于阈值仅允许选图片。

### 67. jue.media.getCamera 权限申请 [提示]

权限名与流程跨端不一致，仅提示统一封装。

### 68. jue.media.onMediaStateChange [跳过]

运行时媒体状态回调，无法静态检测。

## 场景八：jue 定位 / 文件 / 剪贴板（69–78）

### 69. jue.location.getLocation [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 70. jue.location.openLocation [硬校验]

iOS 需 jue ≥ 2.30.0，Android 需 jue ≥ 2.20.0。低于阈值隐藏查看地图入口。

### 71. jue.location.chooseLocation [硬校验]

鸿蒙 ArkTS 不支持。改用列表选择 + 手动坐标。

### 72. jue.file.saveFile [硬校验]

iOS 需 jue ≥ 2.18.0，Android 需 jue ≥ 2.10.0。低于阈值禁用文件保存。

### 73. jue.file.getFileInfo [硬校验]

所有端 jue ≥ 2.15.0 才支持。

### 74. jue.file.readFile [硬校验]

iOS 需 jue ≥ 2.18.0，Android 需 jue ≥ 2.10.0。低于阈值走服务端读取。

### 75. jue.file.writeFile [硬校验]

iOS 需 jue ≥ 2.18.0，Android 需 jue ≥ 2.10.0。低于阈值禁用写入。

### 76. jue.clipboard.setClipboardData [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 77. jue.clipboard.getClipboardData [硬校验]

所有端 jue ≥ 2.8.0 才支持。更早版本不支持读取。

### 78. jue.location.watchLocation [提示]

持续定位的省电与精度跨端不确定，仅提示配置参数分支。

## 场景九：jue 分享 / 登录 / 支付（79–88）

### 79. jue.share.shareAppMessage [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 80. jue.share.shareToTimeline [硬校验]

iOS 需 jue ≥ 2.20.0，Android 需 jue ≥ 2.12.0。低于阈值隐藏时间线分享。

### 81. jue.share.showShareMenu [硬校验]

鸿蒙 ArkTS 不支持。改用自定义分享面板。

### 82. jue.login.login [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 83. jue.login.getUserInfo [硬校验]

iOS 需 jue ≥ 2.30.0，Android 需 jue ≥ 2.25.0。低于阈值从服务端拉取用户资料。

### 84. jue.login.checkSession [硬校验]

所有端 jue ≥ 2.10.0 才支持。

### 85. jue.login.logout [硬校验]

所有端 jue ≥ 2.10.0 才支持。

### 86. jue.pay.requestPayment [硬校验]

iOS 需 jue ≥ 2.35.0，Android 需 jue ≥ 2.30.0。低于阈值禁用支付入口。

### 87. jue.pay.queryOrder [提示]

订单查询字段跨端不确定，仅提示做字段兼容。

### 88. jue.share 自定义分享图生成 [跳过]

涉及图像合成运行时，无法静态检测；统一封装到分享模块。

## 场景十：jue 事件 / 埋点（89–94）

### 89. jue.event.on [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 90. jue.event.off [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 91. jue.event.emit [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 92. jue.event.once [硬校验]

鸿蒙 ArkTS 不支持。改用 on + 手动 off。

### 93. jue.analytics.track [硬校验]

所有端 jue ≥ 2.0.0 才支持。

### 94. jue.analytics.trackEvent [硬校验]

所有端 jue ≥ 2.5.0 才支持。更早版本用 track 兜底。

## 场景十一：平台不确定的语法（提示 / 跳过）（95–100）

### 95. jue.xxx 在未识别平台守卫内的调用 [提示]

平台守卫形态无法识别（非 `if(isXxx)`），仅提示开发者显式补守卫或走通用分支。

### 96. jue 版本 import 路径动态拼接 [跳过]

`import jue from \`.../jue/${var}\`` 版本无法静态解析，仅留档要求路径静态化。

### 97. jue 实例在平台守卫闭包外引用 [提示]

平台判定失效，仅提示把平台相关调用收进守卫闭包内。

### 98. jue 依赖全局注入、未显式 import [提示]

无 import 可追版本，仅提示改为显式 `import jue from '.../jue/<版本>'`。

### 99. jue.* 以 BigInt / 不可序列化对象作参数 [跳过]

序列化语义约束，无法用 selector 静态检测，仅留档禁止。

### 100. jue 的别名引用（import jue as j） [提示]

版本解析需别名追踪，当前按未解析处理，仅提示统一用 `jue` 命名。
