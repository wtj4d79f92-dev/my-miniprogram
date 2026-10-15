# 分享海报素材（已迁到云存储）

海报**不再放代码包**，全部在云开发的云存储里，路径固定为：

```
posters/hiking.jpg     徒步（爬山共用，见 utils/posters.js 的 ALIAS）
posters/driving.jpg    自驾游
posters/camping.jpg    露营
posters/cycling.jpg    骑行
posters/ball.jpg       打球
posters/pet.jpg        宠物会（其他 共用，见 ALIAS）
posters/running.jpg    跑步 —— 缺图，暂用兜底海报
posters/swimming.jpg   游泳 —— 缺图，暂用兜底海报
```

一张方图（1:1）通吃三个出口：微信好友卡片（微信按 5:4 显示）、朋友圈卡片（1:1）、
小程序内「生成分享图片」长图的头图（750 宽等比裁切铺满）。

## 怎么换图 / 加图

- **换图**：把同名文件覆盖上去（云开发控制台「云存储」直接上传到 `posters/` 即可）。
  fileID 由路径决定，覆盖后不用改代码、不用重新发版。
- **加类型**：传 `posters/<类型key>.jpg`，客户端自动就能取到，不用改代码。
  类型 key 见 `utils/dict.js`（hiking / climbing / driving / camping / cycling / ball /
  pet / running / swimming / other）。
- **兜底**：某个类型没有自己的图时用 `utils/posters.js` 里 `FALLBACK_KEY` 指定的那张
  （当前是徒步）。分享卡片**不会**回落到发起人上传的封面 —— 卡片是平台门面。
  小程序内长图的头图是另一条回落：没有海报时画一块该类型主题色的 hero。

## 为什么放云存储

1. 开发者工具「代码质量」那条 `IMAGE_AND_AUDIO_LIMIT` 判定的是**包内所有图片/音频的总和**
   不超过 200KB（不是单张），十来张海报怎么压都过不了；
2. 主包还有 2MB 硬上限；
3. 换图不用发版。

## 出图要求

- **尺寸**：720×720 以上（长图头图按 750 宽绘制）。当前这套是 720×720 / JPEG quality 50，每张 96–125KB。
- **好友卡片的 5:4 安全区**：微信好友卡片是 5:4 的方框，1:1 的图会被上下各裁掉 10%。
  标题、logo 这类不能缺的内容放在高度中间的 80% 里；朋友圈是 1:1，不受影响。
