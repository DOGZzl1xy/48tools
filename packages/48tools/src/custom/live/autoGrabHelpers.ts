/**
 * 自动抓取（自动录制直播）用到的小函数。
 *   - createMemberMatcher：判断一场直播是不是要录的成员。原版把 usersArr.includes(userId) 写成了
 *     usersArr.includes[userId]，按 ID 匹配从来不生效；昵称拼正则时也没有转义特殊字符
 *   - createErrorNotifier：轮询出错时提示用户，同样的错误 10 分钟内只提示一次（轮询每分钟一次，不能每次都弹）
 * 接入点：pages/48/Pocket48/utils/autoGrab.ts。
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param { Array<string> } users - 配置里填的成员姓名或 ID
 * @return 判断函数：昵称包含任意一个名字（不区分大小写），或者 userId 和某一项完全相同
 */
export function createMemberMatcher(users: Array<string>): (nickname: string, userId: string | number) => boolean {
  const list: Array<string> = users.map((user: string): string => user.trim()).filter((user: string): boolean => user !== '');

  if (list.length === 0) return (): boolean => false;

  const nameRegExp: RegExp = new RegExp(list.map(escapeRegExp).join('|'), 'i');
  const ids: Set<string> = new Set(list);

  return (nickname: string, userId: string | number): boolean => nameRegExp.test(nickname) || ids.has(String(userId));
}

/**
 * @param { (text: string) => void } show - 显示提示
 * @param { number } [interval] - 同样的提示多久之内不重复
 * @param { () => number } [now] - 测试用
 */
export function createErrorNotifier(
  show: (text: string) => void,
  interval: number = 10 * 60_000,
  now: () => number = Date.now
): (text: string) => void {
  let lastText: string = '';
  let lastTime: number = 0;

  return (text: string): void => {
    const time: number = now();

    if (text === lastText && time - lastTime < interval) return;

    lastText = text;
    lastTime = time;
    show(text);
  };
}
