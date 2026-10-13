import { describe, expect, it, vi } from 'vitest';
import { AmapService, normalizePoi, parsePolyline } from '../backend/src/services/amap.js';
import { city } from './fixtures/travel.js';
const from = { name: '起点', location: city.center };
const to = { name: '终点', location: { longitude: 120.2, latitude: 30.3 } };
describe('高德数据验证', () => {
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
    const fetcher = vi
      .fn()
      .mockResolvedValue(
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
      vi
        .fn()
        .mockResolvedValue(
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
it('公交无方案时，仅允许高德验证的短距离步行衔接', async () => {
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
  const segment = await new AmapService('test', 0, fetcher).leg(from, to, 'transit', '330100');
  expect(segment.mode).toBe('walking');
  expect(segment.distanceMeters).toBe(750);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
