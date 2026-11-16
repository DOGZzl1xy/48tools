/* 录播列表加载失败的提示，带上接口状态码方便排查（海外 IP 访问口袋48接口会被 CDN 拒绝，返回 403） */
export function recordListErrorText(err: unknown): string {
  const statusCode: number | undefined = (err as { response?: { statusCode?: number } } | null)?.response?.statusCode;

  if (statusCode === 403) {
    return '录播列表加载失败！接口返回 403，当前网络 IP 可能被口袋48拒绝访问。';
  }

  return statusCode ? `录播列表加载失败！接口返回 ${ statusCode }。` : '录播列表加载失败！';
}

/* 接口返回 success: false 时的提示 */
export function recordListFailText(message: string | undefined): string {
  return `录播列表加载失败！${ message ?? '' }`;
}
