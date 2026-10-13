export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    public code = 'REQUEST_FAILED',
  ) {
    super(message);
  }
}
export function publicError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消。';
  return '服务暂时无法完成请求，请稍后重试并检查服务配置。';
}
