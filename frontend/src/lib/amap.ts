declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode?: string };
    __streeAmapPromise__?: Promise<any>;
  }
}

export async function loadAmap(plugins: string[] = []): Promise<any> {
  if (!window.AMap && !window.__streeAmapPromise__) {
    const key = import.meta.env.VITE_AMAP_KEY;
    if (!key) throw new Error('请在 frontend/.env.local 配置高德 JS API Key。');
    const securityCode = import.meta.env.VITE_AMAP_SECURITY_CODE;
    if (securityCode) window._AMapSecurityConfig = { securityJsCode: securityCode };
    window.__streeAmapPromise__ = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = (message: string) => {
        window.clearTimeout(timer);
        script.remove();
        window.__streeAmapPromise__ = undefined;
        reject(new Error(message));
      };
      const timer = window.setTimeout(
        () => fail('高德地图加载超时，请检查网络后重新加载。'),
        15000,
      );
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
      script.async = true;
      script.onload = () => {
        window.clearTimeout(timer);
        if (window.AMap) resolve(window.AMap);
        else fail('高德地图暂时不可用，请检查 JS API Key 和域名白名单。');
      };
      script.onerror = () => fail('高德地图加载失败，请检查网络后重试。');
      document.head.appendChild(script);
    });
  }
  const AMap = window.AMap ?? (await window.__streeAmapPromise__);
  if (plugins.length)
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('高德地图组件加载超时，请重试。')),
        15000,
      );
      AMap.plugin(plugins, () => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  return AMap;
}
