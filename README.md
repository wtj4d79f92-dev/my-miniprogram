# 旷行吖 · 户外组队小程序

按《产品设计文档.md》（PRD v1.0）实现的微信小程序，原生开发 + Skyline 渲染，**默认运行在 Mock 模式**：无需后端、无需云环境，即可完整跑通浏览、筛选、发布、报名、退出、我的活动、分享海报全流程。

## 运行

1. 用微信开发者工具打开本项目根目录（AppID 已配置在 `project.config.json`）；
2. 直接编译即可，首页会自动生成 Mock 活动数据；
3. 需要真机预览时，工具菜单「预览」扫码即可。

## 目录结构

```
app.js / app.json / app.wxss      全局入口、路由与 tabBar、主题变量
pages/
  home/home                       首页：定位、横幅、玩法入口、热门 / 最新
  square/index                    活动广场：类型 / 城市 / 星期 / 排序 / 搜索 / 分页
  activity/detail/index           活动详情：报名退出、协议、群二维码、分享、海报
  activity/publish/index          发布活动：表单校验、自研日历、地图选点、类型联动
  usercenter/index                个人中心：登录、资料编辑、手机号绑定、入口聚合
  user/activity-list/index        我的活动：我参与的 / 我发布的（关闭、打开）
  feedback/index                  意见反馈
components/                       活动卡片、头像、登录弹窗、城市选择、日历、协议弹窗、海报、空态
custom-tab-bar/                   自定义底部导航（首页 / 广场 / 我的）
behaviors/login-behavior.js       登录守卫：弹窗说明 → 一键登录 → 继续原操作
services/
  config.js                       数据层开关（useMock / useCloud、云环境、地图 key）
  api.js                          统一服务层，Mock 与云函数接口签名一致
  mock.js                         Mock 模型：活动生成器 + 本地缓存读写
utils/                            字典、城市、协议文案、定位、存储、交互、工具函数
scripts/validate.js               静态检查 + Mock 业务链路冒烟测试
```

## 数据层：Mock 与云开发

`services/config.js` 中 `useMock` 控制数据来源：

- `useMock: true`（默认）：数据由 `services/mock.js` 生成，操作结果写入本地缓存，缓存键与 PRD 5.3 一致（`aa_selected_city`、`square_pending_type`、`my_user`、`my_user_counter`、`my_published`、`my_joined`、`my_feedback`），另加 `mock_join_map`、`mock_status_map` 两个运行期缓存键用于记录报名成员与关闭状态。
- `useMock: false`：走云开发，客户端调用 `activity` 云函数，action 与 PRD 8.6 完全一致（`home / list / detail / create / join / quit / toggle / mine / user / login / updateUser / qrcode / feedback`）。

### 接入云开发（M5）

1. 在微信开发者工具中开通云开发，记录环境 ID；
2. 把 `services/config.js` 的 `useMock` 改为 `false`，`useCloud` 改为 `true`，填入 `cloudEnv`；
3. 在 `app.js` 的 `onLaunch` 中初始化：`wx.cloud.init({ env: config.cloudEnv, traceUser: true })`；
4. 创建 4 个集合 `activities`、`users`、`banners`、`feedback`，权限按 PRD 8.7 设置；
5. 新建 `cloudfunctions/activity` 云函数（Node.js），按 `services/api.js` 中 `cloudApi` 的 action 名实现路由，返回结构失败为 `{ code, message }`、成功为业务数据；
6. 在 `project.config.json` 中补充 `"cloudfunctionRoot": "cloudfunctions/"` 后部署云函数。

前端页面逻辑不依赖具体数据来源，切换开关即可，无需改动页面代码。

## 校验

```bash
node scripts/validate.js
```

会检查：页面与组件的文件完整性、`usingComponents` 引用是否可解析、JSON 是否合法、JS 是否可通过语法解析，并跑一遍 Mock 业务链路（首页 → 广场筛选 → 详情 → 发布 → 报名 → 我的活动 → 关闭活动 → 退出 → 反馈）。

## 已知限制（与 PRD 12.4 一致）

- Mock 模式下封面 / 群二维码为本地临时路径，仅当前会话有效；
- 发布时间精度只到日期，不选具体时刻；
- 城市归属依赖集合地点文本匹配，个别命名可能误判；
- 活动管理仅支持关闭 / 打开，无编辑与删除；
- 协议主体已按运营方提供的文档填写为「旷行吖科技（成都）有限公司」；《活动发布免责协议》《活动风险告知与免责协议》正文与根目录同名 .docx 逐段一致，管辖法院等条款仍待法务确认。

另外两处按 PRD 建议做了增强：自研日历禁止选择早于今天的日期；集合时间后移时自动顺延返程时间。
