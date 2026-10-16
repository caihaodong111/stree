import type { Coordinate, LocatedRegion, Region } from '@stree/shared';
import { AmapService, parsePolyline } from './amap.js';
import { AppError } from '../errors.js';

// Only administrative destinations are bundled. POIs and routes always come from live providers.
const provinceRows: Array<[string, string, number, number]> = [
  ['110000', '北京市', 116.4074, 39.9042],
  ['120000', '天津市', 117.2008, 39.0842],
  ['130000', '河北省', 114.5149, 38.0428],
  ['140000', '山西省', 112.5492, 37.857],
  ['150000', '内蒙古自治区', 111.7492, 40.8426],
  ['210000', '辽宁省', 123.4315, 41.8057],
  ['220000', '吉林省', 125.3235, 43.8171],
  ['230000', '黑龙江省', 126.6424, 45.7569],
  ['310000', '上海市', 121.4737, 31.2304],
  ['320000', '江苏省', 118.7969, 32.0603],
  ['330000', '浙江省', 120.1551, 30.2741],
  ['340000', '安徽省', 117.2272, 31.8206],
  ['350000', '福建省', 119.2965, 26.0745],
  ['360000', '江西省', 115.8582, 28.6829],
  ['370000', '山东省', 117.1205, 36.6512],
  ['410000', '河南省', 113.6254, 34.7466],
  ['420000', '湖北省', 114.3054, 30.5931],
  ['430000', '湖南省', 112.9388, 28.2282],
  ['440000', '广东省', 113.2644, 23.1291],
  ['450000', '广西壮族自治区', 108.3669, 22.817],
  ['460000', '海南省', 110.1983, 20.044],
  ['500000', '重庆市', 106.5516, 29.563],
  ['510000', '四川省', 104.0665, 30.5723],
  ['520000', '贵州省', 106.6302, 26.647],
  ['530000', '云南省', 102.8329, 24.8801],
  ['540000', '西藏自治区', 91.1409, 29.6456],
  ['610000', '陕西省', 108.9398, 34.3416],
  ['620000', '甘肃省', 103.8343, 36.0611],
  ['630000', '青海省', 101.7782, 36.6171],
  ['640000', '宁夏回族自治区', 106.2309, 38.4872],
  ['650000', '新疆维吾尔自治区', 87.6168, 43.8256],
  ['710000', '台湾省', 121.5654, 25.033],
  ['810000', '香港特别行政区', 114.1694, 22.3193],
  ['820000', '澳门特别行政区', 113.5439, 22.1987],
];
export const provinces: Region[] = provinceRows.map(([adcode, name, longitude, latitude]) => ({
  adcode,
  name,
  center: { longitude, latitude },
  level: 'province',
}));
const municipalityCodes = new Set(['110000', '120000', '310000', '500000', '810000', '820000']);
export function belongsToCity(adcode: string, cityCode: string): boolean {
  if (municipalityCodes.has(cityCode)) return adcode.startsWith(cityCode.slice(0, 2));
  // Province-administered county cities have a complete six-digit destination code.
  return cityCode.endsWith('00') ? adcode.startsWith(cityCode.slice(0, 4)) : adcode === cityCode;
}
export class RegionService {
  private cache = new Map<string, Region[]>();
  constructor(private amap: AmapService) {}
  async locate(position: Coordinate): Promise<LocatedRegion> {
    const adcode = await this.amap.locateDistrict(position);
    return this.locateByAdcode(adcode);
  }
  async locateByAdcode(adcode: string): Promise<LocatedRegion> {
    const province = provinces.find((item) => item.adcode === `${adcode.slice(0, 2)}0000`);
    if (province) {
      const cities = await this.cities(province.adcode);
      const city = cities.find((item) => belongsToCity(adcode, item.adcode));
      if (city) return { province, city };
    }
    throw new AppError(
      '当前位置不在可用的城市目录中，请手动选择目的地。',
      422,
      'LOCATION_UNAVAILABLE',
    );
  }
  async cities(provinceCode: string): Promise<Region[]> {
    const province = provinces.find((p) => p.adcode === provinceCode);
    if (!province) throw new AppError('请选择有效的省份。');
    if (municipalityCodes.has(provinceCode)) return [{ ...province, level: 'city' }];
    const cached = this.cache.get(provinceCode);
    if (cached) return cached;
    const districts = await this.amap.district(provinceCode);
    const children = districts.find((p) => p.adcode === provinceCode)?.districts ?? [];
    const cities: Region[] = children
      .filter((r: any) => r.level === 'city')
      .flatMap((r: any) => {
        const center = parsePolyline(r.center)[0];
        return center
          ? [{ name: String(r.name), adcode: String(r.adcode), center, level: 'city' as const }]
          : [];
      });
    if (!cities.length)
      throw new AppError(
        '高德暂未提供该省份的城市目录，请选择其他目的地。',
        422,
        'REGION_UNAVAILABLE',
      );
    this.cache.set(provinceCode, cities);
    return cities;
  }
  async resolve(
    provinceCode: string,
    cityCode: string,
  ): Promise<{ province: Region; city: Region }> {
    const province = provinces.find((p) => p.adcode === provinceCode);
    const city = (await this.cities(provinceCode)).find((c) => c.adcode === cityCode);
    if (!province || !city) throw new AppError('城市与省份不匹配，请重新选择目的地。');
    return { province, city };
  }
}
