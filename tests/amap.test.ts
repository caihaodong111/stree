import { describe, expect, it, vi } from 'vitest';
import { AmapService, normalizePoi, parsePolyline } from '../backend/src/services/amap.js';
import { city } from './fixtures/travel.js';
const from = { name: '起点', location: city.center };
const to = { name: '终点', location: { longitude: 120.2, latitude: 30.3 } };
it('新版公交传递双方 POI ID，解析嵌套费用与折线并保留五条推荐顺序，刷新跳过缓存', async () => {
  const route = (seconds: number) => ({
    cost: { duration: String(seconds), transit_fee: '9.0' },
    distance: '41756',
    walking_distance: '2013',
    segments: [
      {
        walking: {
          distance: '273',
          cost: { duration: '247' },
          steps: [
            { instruction: '步行至公交站', polyline: { polyline: '120.15,30.27;120.16,30.28' } },
          ],
        },
        bus: {
          buslines: [
            {
              name: '专73路',
              type: '普通公交线路',
              cost: { duration: '1089' },
              distance: '3350',
              polyline: { polyline: '120.16,30.28;120.2,30.3' },
            },
          ],
        },
      },
    ],
  });
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          status: '1',
          route: { transits: [route(7312), route(7000), route(7800), route(8000), route(8100)] },
        }),
      ),
  );
  const service = new AmapService('test', 0, fetcher);
  const origin = { ...from, id: 'origin-poi', adcode: '330106' };
  const destination = { ...to, id: 'destination-poi', adcode: '330102' };
  const routes = await service.directions(origin, destination, 'transit', '330100');
  expect(routes).toHaveLength(5);
  expect(routes.map((r) => r.durationMinutes)).toEqual([122, 117, 130, 134, 135]);
  expect(routes[0]).toMatchObject({
    origin,
    destination,
    price: 9,
    walkingDistanceMeters: 2013,
    distanceMeters: 41756,
  });
  expect(routes[0]!.steps![0]).toMatchObject({
    durationMinutes: 5,
    polyline: [from.location, { longitude: 120.16, latitude: 30.28 }],
  });
  expect(routes[0]!.steps![1]).toMatchObject({ durationMinutes: 19, name: '专73路' });
  const url = fetcher.mock.calls[0]![0] as URL;
  expect(url.pathname).toBe('/v5/direction/transit/integrated');
  expect(url.searchParams.get('originpoi')).toBe('origin-poi');
  expect(url.searchParams.get('destinationpoi')).toBe('destination-poi');
  expect(url.searchParams.get('strategy')).toBe('0');
  expect(url.searchParams.get('AlternativeRoute')).toBe('5');
  await service.directions(origin, destination, 'transit', '330100');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await service.directions(origin, destination, 'transit', '330100', undefined, {
    fresh: true,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
describe('高德数据验证', () => {
  it('热门景点使用城市限定的 POI 2.0 搜索，过滤无效与跨市结果，并合并排队中的重复查询', async () => {
    const spot = {
      id: 'lake',
      name: '西湖',
      adcode: '330106',
      cityname: '杭州市',
      adname: '西湖区',
      address: '龙井路',
      location: '120.14,30.25',
    };
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: '1',
            pois: [
              spot,
              spot,
              { ...spot, id: 'outside', adcode: '510100' },
              { ...spot, id: 'invalid', location: [] },
            ],
          }),
        ),
    );
    const service = new AmapService('test', 0, fetcher);
    const results = await Promise.all([
      service.popularAttractions('330100'),
      service.popularAttractions('330100'),
    ]);
    expect(results[0]).toEqual([
      {
        id: 'lake',
        name: '西湖',
        adcode: '330106',
        district: '杭州市西湖区',
        address: '龙井路',
        location: { longitude: 120.14, latitude: 30.25 },
      },
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = fetcher.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe('/v5/place/text');
    expect(url.searchParams.get('region')).toBe('330100');
    expect(url.searchParams.get('city_limit')).toBe('true');
    expect(url.searchParams.get('types')).toBe('110000');
  });
  it('浏览器 GPS 坐标转换后再逆地理编码，兼容直辖市的空 city 数组', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: '1', locations: '121.46,31.25' })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: '1',
            regeocode: { addressComponent: { adcode: '310106', city: [] } },
          }),
        ),
      );
    const service = new AmapService('test', 0, fetcher);
    expect(await service.locateDistrict({ longitude: 121.455, latitude: 31.249 })).toBe('310106');
    const convert = fetcher.mock.calls[0]![0] as URL;
    expect(convert.pathname).toBe('/v3/assistant/coordinate/convert');
    expect(convert.searchParams.get('coordsys')).toBe('gps');
    expect(convert.searchParams.get('locations')).toBe('121.455,31.249');
    const regeo = fetcher.mock.calls[1]![0] as URL;
    expect(regeo.pathname).toBe('/v3/geocode/regeo');
    expect(regeo.searchParams.get('location')).toBe('121.46,31.25');
    expect(regeo.searchParams.get('extensions')).toBe('base');
  });
  it('坐标转换缺失时不使用原始 GPS 坐标继续查询', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: '1', locations: [] })));
    const service = new AmapService('test', 0, fetcher);
    await expect(service.locateDistrict(city.center)).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('逆地理编码未返回行政区时报告无法识别', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: '1', locations: '120.15,30.27' })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: '1', regeocode: { addressComponent: { adcode: [] } } }),
        ),
      );
    await expect(
      new AmapService('test', 0, fetcher).locateDistrict(city.center),
    ).rejects.toMatchObject({ code: 'LOCATION_UNAVAILABLE' });
  });
  it('全国搜索不带城市且保留跨省提示，仍过滤无效地点与重复项', async () => {
    const tip = {
      id: 'shanghai-station',
      name: '上海站',
      adcode: '310106',
      district: '上海市静安区',
      address: '秣陵路303号',
      location: '121.455,31.249',
    };
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: '1',
            tips: [tip, tip, { ...tip, id: [] }, { ...tip, id: 'invalid', location: [] }],
            pois: [tip],
          }),
        ),
    );
    const service = new AmapService('test', 0, fetcher);
    expect(await service.suggest(undefined, '上海站')).toEqual([
      { ...tip, location: { longitude: 121.455, latitude: 31.249 } },
    ]);
    expect(await service.search(undefined, '上海站', 'any')).toEqual([
      expect.objectContaining({ id: tip.id, adcode: tip.adcode }),
    ]);
    for (const [url] of fetcher.mock.calls) {
      expect((url as URL).searchParams.has('city')).toBe(false);
      expect((url as URL).searchParams.get('citylimit')).toBe('false');
    }
  });
  it('输入提示限制城市，只保留有 ID 与坐标的真实地点，并缓存同一查询', async () => {
    const tip = {
      id: 'station',
      name: '杭州东站',
      adcode: '330102',
      district: '浙江省杭州市上城区',
      address: '天城路1号',
      location: '120.21,30.29',
    };
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: '1',
            tips: [
              tip,
              tip,
              { ...tip, id: [] },
              { ...tip, id: 'outside', adcode: '510100' },
              { ...tip, id: 'no-coordinate', location: [] },
            ],
          }),
        ),
    );
    const service = new AmapService('test', 0, fetcher);
    expect(await service.suggest('330100', '杭州东')).toEqual([
      { ...tip, location: { longitude: 120.21, latitude: 30.29 } },
    ]);
    await service.suggest('330100', '杭州东');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = fetcher.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe('/v3/assistant/inputtips');
    expect(url.searchParams.get('citylimit')).toBe('true');
    expect(url.searchParams.get('datatype')).toBe('poi');
  });
  it('按用户选择的 ID 读取详情，缺失时不会接受另一个地点', async () => {
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: '1',
            pois: [{ id: 'chosen', name: '同名地点', adcode: '330102', location: '120.21,30.29' }],
          }),
        ),
    );
    const service = new AmapService('test', 0, fetcher);
    expect(await service.detail('chosen')).toMatchObject({ id: 'chosen', name: '同名地点' });
    expect(await service.detail('missing')).toBeNull();
  });
  it('过滤非法坐标和相邻重复点', () =>
    expect(parsePolyline('120.1,30.2;120.1,30.2;wrong;300,99;120.2,30.3')).toEqual([
      { longitude: 120.1, latitude: 30.2 },
      { longitude: 120.2, latitude: 30.3 },
    ]));
  it('不使用无坐标 POI，不把空数组当作价格', () => {
    expect(normalizePoi({ id: 'x', name: 'x', location: 'invalid' })).toBeNull();
    expect(
      normalizePoi({ id: 'x', name: 'x', location: '120.1,30.2', biz_ext: { cost: [] } })
        ?.referencePrice,
    ).toBeNull();
  });
  it('返回实际公交线路和路径并缓存相同查询', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: '1',
          route: {
            transits: [
              {
                duration: '1500',
                distance: '6000',
                cost: '4',
                segments: [
                  {
                    walking: { steps: [{ polyline: '120.15,30.27;120.16,30.28' }] },
                    bus: {
                      buslines: [{ name: '地铁测试线', polyline: '120.16,30.28;120.2,30.3' }],
                    },
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
    const service = new AmapService('test', 0, fetcher);
    const segment = await service.leg(from, to, 'transit', '330100');
    expect(segment).toMatchObject({
      source: 'amap',
      durationMinutes: 25,
      distanceMeters: 6000,
      price: 4,
      summary: '地铁测试线',
    });
    expect(segment.polyline.length).toBeGreaterThan(2);
    await service.leg(from, to, 'transit', '330100');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('查询失败不生成直线或虚构公交', async () => {
    const service = new AmapService(
      'test',
      0,
      vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify({ status: '1', route: { transits: [] } })),
        ),
    );
    await expect(service.leg(from, to, 'transit', '330100')).rejects.toMatchObject({
      code: 'NO_ROUTE',
    });
  });
  it('路径缺失不能作为真实路线通过', async () => {
    const service = new AmapService(
      'test',
      0,
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: '1',
            route: { paths: [{ duration: '120', distance: '200', steps: [] }] },
          }),
        ),
      ),
    );
    await expect(service.leg(from, to, 'walking', '330100')).rejects.toMatchObject({
      code: 'INCOMPLETE_ROUTE',
    });
  });
  it('不把 Web 服务 Key 带入错误信息', async () => {
    const service = new AmapService(
      'secret-test-key',
      0,
      vi.fn().mockRejectedValue(new Error('secret-test-key')),
    );
    await expect(service.search('330100', '湖')).rejects.toThrow('高德服务连接超时');
  });
});
it('公交无方案时返回该方式无路线，交由 AI 选择步行，不由后端自动切换', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: '1', route: { transits: [] } })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: '1',
          route: {
            paths: [
              {
                duration: '600',
                distance: '750',
                steps: [{ polyline: '120.15,30.27;120.16,30.28' }],
              },
            ],
          },
        }),
      ),
    );
  const service = new AmapService('test', 0, fetcher);
  await expect(service.leg(from, to, 'transit', '330100')).rejects.toMatchObject({
    code: 'NO_ROUTE',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const segment = await service.leg(from, to, 'walking', '330100');
  expect(segment.mode).toBe('walking');
  expect(segment.distanceMeters).toBe(750);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('保留公交备选方案、上下车站和步行衔接，同段备选线路不会串成换乘', async () => {
  const ride = {
    name: '地铁1号线',
    type: '地铁线路',
    duration: '900',
    distance: '5000',
    polyline: '120.16,30.28;120.20,30.30',
    departure_stop: { name: '起乘站' },
    arrival_stop: { name: '到达站' },
    via_num: '2',
    via_stops: [{ name: '中间站甲' }, { name: '中间站乙' }],
  };
  const transit = {
    duration: '1200',
    cost: '4',
    walking_distance: '200',
    segments: [
      {
        walking: {
          duration: '180',
          distance: '200',
          steps: [
            {
              instruction: '沿湖滨路步行100米',
              distance: '100',
              polyline: '120.15,30.27;120.155,30.275',
            },
            {
              instruction: '直行100米到起乘站',
              distance: '100',
              polyline: '120.155,30.275;120.16,30.28',
            },
          ],
        },
        entrance: { name: 'A口' },
        exit: { name: 'B口' },
        bus: { buslines: [ride, { ...ride, name: '备选2路', polyline: '120.3,30.4;120.4,30.5' }] },
      },
    ],
  };
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: '1',
        route: {
          transits: [
            transit,
            {
              ...transit,
              duration: '1500',
              segments: [
                {
                  bus: {
                    buslines: [
                      { ...ride, type: '普通公交线路', name: '919路(地铁北土城站--樾熙府小区)' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    ),
  );
  const routes = await new AmapService('test', 0, fetcher).directions(
    from,
    to,
    'transit',
    '330100',
  );
  expect(routes).toHaveLength(2);
  expect(routes[0]).toMatchObject({
    transfers: 0,
    distanceMeters: 5200,
    walkingDistanceMeters: 200,
    summary: '地铁1号线',
  });
  expect(routes[0]!.steps).toHaveLength(2);
  expect(routes[0]!.steps![0]).toMatchObject({
    mode: 'walking',
    instruction: '步行至起乘站',
    durationMinutes: 3,
    instructions: ['沿湖滨路步行100米', '直行100米到起乘站'],
  });
  expect(routes[0]!.steps![1]).toMatchObject({
    mode: 'subway',
    departureStop: '起乘站',
    arrivalStop: '到达站',
    stopCount: 3,
    entrance: 'A口',
    exit: 'B口',
  });
  expect(routes[0]!.polyline).not.toContainEqual({ longitude: 120.3, latitude: 30.4 });
  expect(routes[1]!.steps![0]!.mode).toBe('bus');
});
it('驾车返回多方案、道路指引和红绿灯数量，未知路桥费保留为空', async () => {
  const path = {
    duration: '900',
    distance: '6000',
    traffic_lights: '12',
    tolls: [],
    steps: [
      {
        instruction: '沿湖滨路直行',
        road: '湖滨路',
        distance: '6000',
        polyline: '120.15,30.27;120.2,30.3',
      },
    ],
  };
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: '1',
        route: { paths: [path, { ...path, duration: '1200' }, { ...path, steps: [] }] },
      }),
    ),
  );
  const routes = await new AmapService('test', 0, fetcher).directions(
    from,
    to,
    'driving',
    '330100',
  );
  expect(routes).toHaveLength(2);
  expect(routes[0]).toMatchObject({ price: null, trafficLights: 12, summary: '湖滨路' });
  expect(routes[0]!.steps![0]).toMatchObject({
    mode: 'driving',
    instruction: '沿湖滨路直行',
    durationMinutes: null,
  });
  expect((fetcher.mock.calls[0]![0] as URL).searchParams.get('strategy')).toBe('10');
});
it('查看公交无方案时不会悄悄改为步行，仍兼容缺少逐步指引的历史行程', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ status: '1', route: { transits: [] } })));
  await expect(
    new AmapService('test', 0, fetcher).directions(from, to, 'transit', '330100'),
  ).rejects.toMatchObject({ code: 'NO_ROUTE' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('骑行使用 v5 接口，解析嵌套时间、道路和折线，未知租车费用不伪造为零', async () => {
  const path = {
    distance: '2400',
    cost: { duration: '721' },
    steps: [
      {
        instruction: '沿湖滨路向北骑行',
        road_name: '湖滨路',
        step_distance: '2400',
        cost: { duration: '721' },
        polyline: { polyline: '120.15,30.27;120.2,30.3' },
      },
    ],
  };
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: '1',
        route: { paths: [path, { ...path, cost: { duration: '900' } }] },
      }),
    ),
  );
  const routes = await new AmapService('test', 0, fetcher).directions(
    from,
    to,
    'cycling',
    '330100',
  );
  const url = fetcher.mock.calls[0]![0] as URL;
  expect(url.pathname).toBe('/v5/direction/bicycling');
  expect(url.searchParams.get('show_fields')).toBe('cost,polyline');
  expect(url.searchParams.get('alternative_route')).toBe('3');
  expect(routes).toHaveLength(2);
  expect(routes[0]).toMatchObject({
    mode: 'cycling',
    durationMinutes: 13,
    distanceMeters: 2400,
    summary: '湖滨路',
    price: null,
    walkingDistanceMeters: null,
  });
  expect(routes[0]!.steps![0]).toMatchObject({
    mode: 'cycling',
    name: '湖滨路',
    distanceMeters: 2400,
    durationMinutes: 13,
  });
  expect(routes[0]!.polyline).toEqual([from.location, to.location]);
});
it('骑行无方案时提示骑行错误，不替换成驾车或步行', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ status: '1', route: { paths: [] } })));
  await expect(
    new AmapService('test', 0, fetcher).directions(from, to, 'cycling', '330100'),
  ).rejects.toMatchObject({ code: 'NO_ROUTE', message: expect.stringContaining('骑行') });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
