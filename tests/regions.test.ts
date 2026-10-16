import { describe, it, expect, vi } from 'vitest';
import { belongsToCity, RegionService } from '../backend/src/services/regions.js';
import type { AmapService } from '../backend/src/services/amap.js';
describe('全国城市边界', () => {
  it('普通地级市允许其下辖区县', () => {
    expect(belongsToCity('330106', '330100')).toBe(true);
    expect(belongsToCity('330206', '330100')).toBe(false);
  });
  it('直辖市按整市行政范围查询', () => {
    expect(belongsToCity('310101', '310000')).toBe(true);
    expect(belongsToCity('320100', '310000')).toBe(false);
  });
  it('省直辖县级市不能误包含邻近城市', () => {
    expect(belongsToCity('469005', '469005')).toBe(true);
    expect(belongsToCity('469006', '469005')).toBe(false);
    expect(belongsToCity('429005', '429004')).toBe(false);
  });
});

describe('定位匹配城市目录', () => {
  const position = { longitude: 120.15, latitude: 30.27 };
  function service(adcode: string) {
    const amap = {
      locateDistrict: vi.fn().mockResolvedValue(adcode),
      district: vi.fn().mockResolvedValue([
        {
          adcode: `${adcode.slice(0, 2)}0000`,
          districts: [
            { adcode: '330100', name: '杭州市', center: '120.15,30.27', level: 'city' },
            { adcode: '469005', name: '文昌市', center: '110.8,19.5', level: 'city' },
          ],
        },
      ]),
    };
    return { regions: new RegionService(amap as unknown as AmapService), amap };
  }
  it('区县定位匹配其地级市，不直接填入区县代码', async () => {
    const { regions, amap } = service('330106');
    expect(await regions.locate(position)).toMatchObject({
      province: { adcode: '330000' },
      city: { adcode: '330100' },
    });
    expect(amap.locateDistrict).toHaveBeenCalledWith(position);
  });
  it('直辖市区县匹配整市，不依赖城市目录请求', async () => {
    const { regions, amap } = service('310106');
    expect(await regions.locate(position)).toMatchObject({
      province: { adcode: '310000' },
      city: { adcode: '310000' },
    });
    expect(amap.district).not.toHaveBeenCalled();
  });
  it('省直辖县级市保留完整目的地代码', async () => {
    expect(await service('469005').regions.locate(position)).toMatchObject({
      province: { adcode: '460000' },
      city: { adcode: '469005' },
    });
  });
  it('不在目录的行政区不会猜测或回退到其他城市', async () => {
    await expect(service('330299').regions.locate(position)).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
    });
    await expect(service('990001').regions.locate(position)).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
    });
  });
});
