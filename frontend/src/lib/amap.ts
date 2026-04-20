declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: {
      securityJsCode?: string;
    };
    __streeAmapPromise__?: Promise<any>;
  }
}

export async function loadAmap(pluginNames: string[] = []): Promise<any> {
  if (window.AMap) {
    await loadPlugins(window.AMap, pluginNames);
    return window.AMap;
  }

  if (!window.__streeAmapPromise__) {
    const amapKey = import.meta.env.VITE_AMAP_KEY;
    const securityCode = import.meta.env.VITE_AMAP_SECURITY_CODE;

    if (!amapKey) {
      throw new Error("缺少高德地图 Key，请配置 VITE_AMAP_KEY。");
    }

    if (securityCode) {
      window._AMapSecurityConfig = {
        securityJsCode: securityCode
      };
    }

    window.__streeAmapPromise__ = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${amapKey}&plugin=AMap.Scale,AMap.ToolBar,AMap.Geocoder`;
      script.async = true;
      script.onload = () => {
        if (window.AMap) {
          resolve(window.AMap);
          return;
        }
        reject(new Error("高德地图脚本加载完成，但 AMap 对象不可用。"));
      };
      script.onerror = () => reject(new Error("高德地图脚本加载失败。"));
      document.head.appendChild(script);
    });
  }

  const AMap = await window.__streeAmapPromise__;
  await loadPlugins(AMap, pluginNames);
  return AMap;
}

function loadPlugins(AMap: any, pluginNames: string[]): Promise<void> {
  if (!pluginNames.length) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    AMap.plugin(pluginNames, () => resolve());
  });
}

export async function geocodePlace(keyword: string): Promise<{ name: string; latitude: number; longitude: number }> {
  const query = keyword.trim();
  if (!query) {
    throw new Error("请输入地点。");
  }

  const AMap = await loadAmap(["AMap.Geocoder"]);

  return new Promise((resolve, reject) => {
    const geocoder = new AMap.Geocoder({
      city: "全国"
    });

    geocoder.getLocation(query, (status: string, result: any) => {
      if (status !== "complete" || result.info !== "OK" || !result.geocodes?.length) {
        reject(new Error(`无法识别地点：${query}`));
        return;
      }

      const first = result.geocodes[0];
      resolve({
        name: first.formattedAddress || query,
        longitude: Number(first.location.lng),
        latitude: Number(first.location.lat)
      });
    });
  });
}
