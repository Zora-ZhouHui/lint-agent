# 团队约定

## 网络：统一使用封装的 request

所有端（H5 / 安卓 / iOS / 鸿蒙）统一使用 `utils/request` 封装，
它内置了域名白名单、错误码上报和登录态续期。
禁止在任何跨端代码里直接调用 `fetch`。

## 命名与代码风格

- 跨端工具函数放在 `src/utils/cross/`，禁止在业务代码里写平台判断
- 禁止使用 `process.env` 做运行时平台判断，统一用 `getPlatform()`
