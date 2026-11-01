import { Bot, ReceiverMode } from 'qq-official-bot'
import { env } from './env.js'

// QQ 网关只建一次连接：发送层、媒体发送器、巡检都共用这一个实例
export const bot = new Bot({
  appid: env.appId,
  secret: env.appSecret,
  intents: ['GROUP_AND_C2C_EVENT'],
  mode: ReceiverMode.WEBSOCKET,
  removeAt: true,
  logLevel: env.logLevel,
})
