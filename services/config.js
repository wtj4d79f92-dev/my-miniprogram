// 数据层开关与云环境配置
// useMock = true  ：本地 Mock 模式，无需后端即可跑通全部业务
// useMock = false ：云开发模式，走 activity 云函数（见 README「接入云开发」）
module.exports = {
  useMock: false,
  useCloud: true,
  // 云开发环境 ID，形如 'kuangxingya-1g2h3i4j'
  cloudEnv: 'cloud1-d2gcrlr5qbe1d05d4',
  // 腾讯位置服务 key：定位后的逆地址解析 + 点地址导航时的地理编码（把地址文本解析成坐标）
  // 留空时定位按经纬度就近匹配城市，导航解析不出坐标则引导用户在地图上点选位置
  // （填了还要在小程序后台把 apis.map.qq.com 加进 request 合法域名）
  mapKey: '',
  // Mock 接口模拟延时（毫秒）
  mockDelay: 300,
}
