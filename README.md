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
  activity/detail/index           活动详情：报名退出、发起人关闭 / 打开活动、协议、群二维码、分享、海报
  activity/publish/index          发布活动：表单校验、自研日历、地图选点、类型联动
  usercenter/index                个人中心：登录、资料编辑、手机号绑定、入口聚合
  user/activity-list/index        我的活动：我参与的 / 我发布的（关闭、打开）
  feedback/index                  意见反馈
  admin/audit/index               活动审核台：待审 / 已通过 / 已驳回 / 全部、详情预览、通过 / 驳回
components/                       活动卡片、头像、登录页、城市选择、日历、协议弹窗、海报、空态
custom-tab-bar/                   自定义底部导航（首页 / 广场 / 我的）
behaviors/login-behavior.js       登录守卫：全屏登录页 → 登录成功 → 继续原操作
services/
  config.js                       数据层开关（useMock / useCloud、云环境、地图 key）
  api.js                          统一服务层，Mock 与云函数接口签名一致
  mock.js                         Mock 模型：活动生成器 + 本地缓存读写
utils/                            字典、城市、协议文案、定位、存储、交互、审核状态、工具函数
cloudfunctions/
  activity/                       活动业务云函数（发布 / 报名 / 审核状态 / 内容安全送检）
  admin/                          审核台云函数（白名单校验、待审列表、通过 / 驳回、审核日志）
  contentCheck/                   内容安全异步结果回调（消息推送接收方）
scripts/validate.js               静态检查 + Mock 业务链路冒烟测试
scripts/cloud-validate.js         云函数离线校验（内存数据库跑 activity / admin / contentCheck 链路）
```

## 数据层：Mock 与云开发

`services/config.js` 中 `useMock` 控制数据来源：

- `useMock: true`（默认）：数据由 `services/mock.js` 生成，操作结果写入本地缓存，缓存键与 PRD 5.3 一致（`aa_selected_city`、`square_pending_type`、`my_user`、`my_user_counter`、`my_published`、`my_joined`、`my_feedback`），另加 `mock_join_map`、`mock_status_map`、`mock_audit_map` 三个运行期缓存键，用于记录报名成员、关闭状态与本地审核结果。
- `useMock: false`：走云开发，客户端调用 `activity` 云函数，action 与 PRD 8.6 一致（`home / list / detail / create / update / join / quit / toggle / mine / user / login / updateUser / qrcode / feedback`），审核相关调用走独立的 `admin` 云函数。

> Mock 模式下把当前登录用户视为审核人，本地也能把「发布 → 待审 → 驳回 → 修改重提 → 通过」整条链路跑通；云端真人权限见下方「活动审核」。

### 接入云开发（M5）

1. 在微信开发者工具中开通云开发，记录环境 ID；
2. 把 `services/config.js` 的 `useMock` 改为 `false`，`useCloud` 改为 `true`，填入 `cloudEnv`；
3. 在 `app.js` 的 `onLaunch` 中初始化：`wx.cloud.init({ env: config.cloudEnv, traceUser: true })`；
4. 创建 4 个集合 `activities`、`users`、`banners`、`feedback`，权限按 PRD 8.7 设置；
5. 新建 `cloudfunctions/activity` 云函数（Node.js），按 `services/api.js` 中 `cloudApi` 的 action 名实现路由，返回结构失败为 `{ code, message }`、成功为业务数据；
6. 在 `project.config.json` 中补充 `"cloudfunctionRoot": "cloudfunctions/"` 后部署云函数。

前端页面逻辑不依赖具体数据来源，切换开关即可，无需改动页面代码。

## 活动审核

用户提交的活动不会直接对外可见，需要审核通过后才展示。状态字段与业务状态（招募中 / 已关闭）分离，互不覆盖：

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| `auditStatus` | 审核状态 | `pending` 审核中 / `approved` 已通过 / `rejected` 未通过 |
| `auditRemark` | 驳回原因，发起人可见 | 审核人填写，最多 200 字 |
| `auditTime` / `auditBy` | 审核时间与审核人 | 由 admin 云函数写入 |
| `submitTime` | 提交审核时间 | 待审队列按它倒序，编辑重提会重新排到最前 |

规则：

1. 发布、编辑后一律回到 `pending`；编辑已通过的活动也会重新送审（否则先发合规内容过审、再改成违规内容就能绕过审核）；
2. 首页、广场、列表的查询都带审核条件，`pending` / `rejected` 只有发起人自己能看到（详情页会给发起人展示审核提示条）；
3. 审核中 / 未通过的活动不能报名、不能关闭或打开；
4. 没有 `auditStatus` 字段的历史数据按「已通过」处理（查询用 `nin` 而不是 `eq`），所以**上线审核能力不会让存量活动从列表里消失**；
5. 驳回后发起人在「我的发布」里能看到原因，并可直接进入发布页修改重提。

### 封面 / 群二维码的云存储地址

封面与群二维码以 `cloud://` 文件 ID 落库，而审核人通常是另一个微信号：客户端直接渲染别人的云存储文件，能不能加载完全取决于云存储的权限设置 / 安全规则，被限制成「仅创建者可读」时审核台只会看到「封面加载失败」。因此：

1. `admin` 云函数的列表与详情用管理员身份把 `cloud://` 批量换成 `https` 临时链接（响应里的 `media: { [fileID]: { url, ok, reason } }`），审核台优先渲染这些地址，图片位置只作为兜底；
2. 首页 / 广场 / 我的活动 / 活动详情由 `activity` 云函数下发同样的临时链接（活动上的 `coverUrl` / `qrUrl`），活动卡片与详情页优先渲染它们，两者都保留原始 `cover` / `groupQrCode` 以便重取；
3. 临时链接默认 2 小时过期，图片加载失败时前端按 fileID 调 `media` 接口重取一次，仍失败才退回默认海报 / 占位图；
4. 服务端也取不到时（文件被删、上传到了别的环境、权限过严），审核台会直接说清原因并把 fileID 露出来，而不是留一块空白灰块；
5. `activity` 云函数在发布 / 编辑写库前会用同样的方式校验一次：明确「文件不存在」就返回 `UPLOAD_FAILED` 让用户重新上传，接口本身异常则放行（不能因为云存储抖动让用户发不出活动）。

> 云开发控制台「存储 → 权限设置」正常应是「所有用户可读，仅创建者可读写」，但客户端渲染仍可能被安全规则、跨环境文件 ID 影响，所以列表接口不再依赖客户端直读云存储。仍走客户端 `wx.cloud.downloadFile` 的是分享海报里的群二维码与小程序码（画布需要本地文件），若这两张图偶发缺失，可用同一条 `media` 接口替换来源。

### 部署步骤

1. 部署 `cloudfunctions/admin`（审核台）、`cloudfunctions/activity`（业务改动）两个云函数；
2. 给自己开通审核权限，二选一：
   - 在 `admin` 云函数的环境变量里配置 `ADMIN_OPENIDS=<你的 openid>`（首位管理员用这个，openid 可以在审核页的「没有审核权限」提示里直接复制）；
   - 新建 `admins` 集合，写入 `{ "openid": "...", "name": "运营昵称" }`，日常增删审核人只改这里；
3. 可选：在审核台底部点「补齐全量审核状态」，给历史活动写入显式的 `approved`（幂等，可重复执行，不迁移也不影响展示）；
4. 重新编译小程序，登录后「我的」页会出现「活动审核」入口（仅审核人可见）。

配套集合：`activity_audits` 记录每次审核的动作、前后状态、原因、审核人与时间（集合不存在时会自动跳过写日志，不阻塞审核）。集合权限建议设为「仅创建者可读写」或「所有用户不可读写」，只通过云函数访问。

## 内容安全检测

审核解决「人来看」，内容安全解决「机器先筛」：机器拦下明确违规的，疑似与正常的进人工队列。文本和图片的实现路径不同：

| 检测对象 | 接口 | 特点 | 接入点 |
| --- | --- | --- | --- |
| 标题 / 地点 / 活动介绍 | `security.msgSecCheck` | 同步返回结论 | `activity` 云函数的 `create` / `update` |
| 封面 / 群二维码 | `security.mediaCheckAsync` | 异步，只返回 `trace_id`，结论靠消息推送回调 | 同上发起，`contentCheck` 云函数接收 |

结论的处理方式：

| 机器结论 | 文本 | 图片 |
| --- | --- | --- |
| `risky` | 直接拦下：返回 `CONTENT_RISKY`，**不写库**，用户在发布页看到提示后修改重发 | 直接驳回：审核中的标记未通过；**已上线的立即下架**，发起人看到「图片经内容安全检测判定违规」 |
| `review` | 正常进待审，同时打 `machineReview` 标记，审核台提示「机器需复核」 | 同上 |
| `pass` | 正常进待审（第一版不做自动放行，人工仍过一遍） | 写回 `pass`，清除「图片检测中」 |

活动文档会落 `machineCheck: { text, images, checkedAt }`，以及便于查询的 `machineReview` / `machinePending` 标记，审核台详情页直接展示文本结论与每张图的检测结果。

### 关键取舍

**检测接口失败一律降级为纯人工审核**（接口未开通、超出额度、openid 不满足条件、云存储临时链接生成失败等），只打 `console.error` 并留下 `failed: true` 标记，绝不因为内容安全自身出问题而让用户发不出活动。

图片送检先用 `cloud.getTempFileURL` 把 `cloud://` 文件 ID 换成临时 http 链接——`mediaCheckAsync` 只接受可访问的 URL，不接受云存储文件 ID。

### 部署步骤

1. `cloudfunctions/activity/config.json` 已声明 `security.msgSecCheck`、`security.mediaCheckAsync` 权限，重新部署 `activity` 云函数即可生效；
2. 在 mp 后台「开发管理 → 接口设置」开通内容安全接口；
3. 部署 `cloudfunctions/contentCheck`，再到 mp 后台「开发管理 → 消息推送」选择**云开发消息推送**并指向 `contentCheck` 云函数——图片结论只能通过这条链路回来，不配就永远拿不到结果（这一页的 URL / Token / EncodingAESKey 都不用填）；
4. 消息推送**全小程序只能配一个接收方**，以后要接客服消息等其他事件，在 `contentCheck` 里按 `MsgType` / `Event` 分发。
5. 建议给 `activities` 集合加一个 `machineCheck.images.traceId` 索引，回调查找走的是这个字段（数据量小的时候不加也能跑）。

时序上有个已知窗口：图片结论回来之前活动可能已被人工放行，此时若判定违规会自动下架（复用同一套 `auditStatus: rejected`，发起人能看到原因）。要彻底避免，可在审核台对 `machinePending` 的活动暂缓通过。

Mock 模式下用关键词模拟：「违规 / 赌博 / 代刷 / 外挂」会被拦下，「疑似 / 兼职」会标记为需复核，方便本地验证拦截与审核台展示。

## 校验

```bash
node scripts/validate.js
node scripts/cloud-validate.js
```

会检查：页面与组件的文件完整性、`usingComponents` 引用是否可解析、JSON 是否合法、JS 是否可通过语法解析，并跑一遍 Mock 业务链路（首页 → 广场筛选 → 详情 → 发布 → 报名 → 我的活动 → 关闭活动 → 退出 → 反馈）。

`scripts/cloud-validate.js` 用内存数据库替代 `wx-server-sdk`，直接调用三个云函数的入口，覆盖：审核前后在首页 / 广场 / 详情的可见性、发布与编辑重提、报名与关闭的审核守卫、审核人权限（含越权调用被拒）、待审列表与统计、驳回原因校验、审核日志、历史数据迁移，以及内容安全（文本违规拦截不写库、疑似标记复核、图片异步回调写回、图片违规自动驳回与下架、接口异常降级）。内容安全接口在测试里是桩，通过行为开关切换 pass / review / risky / 调用失败四种情况。它是纯本地运行，不依赖云环境，也不改动云端数据。

## 已知限制（与 PRD 12.4 一致）

- Mock 模式下封面 / 群二维码为本地临时路径，仅当前会话有效；
- 发布时间精度只到日期，不选具体时刻；
- 城市归属依赖集合地点文本匹配，个别命名可能误判；地址里认不出城市（如手输「双流区润和路附近」）时按发布者当前城市兜底，本次改动之前发布的同类活动需要编辑重提一次才会重新归属；
- 地图选点发布的活动带着坐标，点「导航」直接开地图；只有地址文本的老活动（含本次改动前发布的）要先把地址解析成坐标，这一步依赖腾讯位置服务 key（`services/config.js` 的 `mapKey`）与 `apis.map.qq.com` 的 request 合法域名，未配置时应用会请用户在地图上点一次位置再导航；
- 活动管理支持关闭 / 打开与编辑重提，暂不支持删除；
- 审核结果暂未通过订阅消息通知发起人（订阅消息需用户在发布时授权「审核结果通知」，属于独立的一步）；
- 内容安全已接入，但 `review` 结论只做标记，不做自动放行；
- 协议主体已按运营方提供的文档填写为「旷行吖科技（成都）有限公司」；《活动发布免责协议》《活动风险告知与免责协议》正文与根目录同名 .docx 逐段一致，管辖法院等条款仍待法务确认。

另外几处按 PRD 建议做了增强：自研日历禁止选择早于今天的日期；集合时间后移时自动顺延返程时间；地图选点把「展示值」和「匹配值」拆开——`location` 存「选点地址的省 + 市 + 地点名」（如「四川省成都市 华府大道地铁站」，表单、广场、详情、海报都显示它；地点名本身已带省市时不重复加），完整地址另存 `locationAddress` 且不出现在任何展示位，只用于城市归属与地址关键词检索，所以活动既不会「选 A 显示 B」，也不会因为地点名没带省市而归错城市；地点文本带上省市后，只有地址文本的老活动点「导航」时地理编码的命中率也更高。

集合地点缺省市时还有两层兜底：发布页在输入框下方直接提示「活动将按当前城市展示」，服务端在城市匹配不出时用这个当前城市兜底落库，避免活动城市为空、按城市筛选永远看不到；点地点调起导航时同一条地址会带上城市再解析一次，仍解析不出坐标就请用户在地图上点一次，选中后立刻用该坐标调起地图软件，不再只留一个「无法自动定位」的弹窗。
