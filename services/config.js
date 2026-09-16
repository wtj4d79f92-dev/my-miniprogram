// 数据层开关与云环境配置
// useMock = true  ：本地 Mock 模式，无需后端即可跑通全部业务
// useMock = false ：云开发模式，走 activity 云函数（见 README「接入云开发」）
module.exports = {
  useMock: false,
  useCloud: true,
  // 云开发环境 ID，形如 'kuangxingya-1g2h3i4j'
  cloudEnv: 'cloud1-d2gcrlr5qbe1d05d4',
  // 腾讯位置服务 key，用于定位后的逆地址解析（留空则按经纬度就近匹配城市）
  mapKey: '',
  // Mock 接口模拟延时（毫秒）
  mockDelay: 300,
}
