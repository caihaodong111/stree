import { api } from '../api';
import { loadAmap } from './amap';

async function networkCity(signal: AbortSignal): Promise<string> {
  const AMap = await loadAmap(['AMap.Geolocation']);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, adcode?: string) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(adcode!);
    };
    const abort = () => finish(new DOMException('请求已取消。', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('网络城市识别超时。')), 8000);
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Runs in the visitor's browser, so this queries their network rather than the server's.
      new AMap.Geolocation().getCityInfo((status: string, result: { adcode?: string }) => {
        const adcode = result?.adcode;
        if (status === 'complete' && typeof adcode === 'string' && /^\d{6}$/.test(adcode))
          finish(undefined, adcode);
        else finish(new Error('网络暂未提供可用的城市信息。'));
      });
    } catch {
      finish(new Error('网络城市识别暂时不可用。'));
    }
  });
}

export async function locateUserRegion(signal: AbortSignal, onFallback?: () => void) {
  let position: GeolocationPosition;
  try {
    position = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000,
      }),
    );
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as { code?: number })?.code;
    // Respect permission denial. Only unavailable positions or timeouts use the network fallback.
    if (code !== 2 && code !== 3) throw error;
    onFallback?.();
    try {
      const adcode = await networkCity(signal);
      const region = await api.locateCity(adcode, signal);
      return { region, approximate: true };
    } catch (fallbackError) {
      signal.throwIfAborted();
      const reason = code === 3 ? '浏览器定位超时' : '浏览器暂时无法获取位置';
      const detail = fallbackError instanceof Error ? fallbackError.message : '网络城市识别失败。';
      throw new Error(
        `${reason}，网络城市识别也未完成。${detail} 请检查系统定位与网络连接，或手动选择省市。`,
      );
    }
  }
  signal.throwIfAborted();
  const region = await api.locate(
    { longitude: position.coords.longitude, latitude: position.coords.latitude },
    signal,
  );
  return { region, approximate: false };
}
