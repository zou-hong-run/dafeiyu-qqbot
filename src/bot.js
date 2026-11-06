// SDK 适配层的统一出口。
// 业务代码从这里拿 bot / segment / 发送函数，不直接依赖任何 SDK。
export {
  bot,
  segment,
  sendGroup,
  sendPrivate,
  recallGroup,
  recallPrivate,
  uploadMedia,
  postRaw,
  openPrivateStream,
  onMessage,
  toLegacyEvent,
  start,
  stop,
  selfOpenid,
} from './qq/client.js'
