/* 用系统的加密功能保存 API key 用到的 ipc 通道名。主进程（./secretStore）和界面（48tools/src/custom/settings/secretBox）共用 */
export const enum SecretChannel {
  Encrypt = 'custom:secret:encrypt', // 同步：明文 → 加密后的文字（base64）；系统不支持加密时返回 null
  Decrypt = 'custom:secret:decrypt'  // 同步：加密后的文字 → 明文；解不开时返回 null
}
