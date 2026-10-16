export function clsx(...values: (string | false | undefined | null)[]) {
  return values.filter(Boolean).join(' ');
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请重试。';
}
