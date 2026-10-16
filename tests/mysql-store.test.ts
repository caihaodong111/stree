import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { TripSchema } from '@stree/shared';
import { MysqlTripStore } from '../backend/src/db/store.js';
import { config } from '../backend/src/config.js';
import { tripFixture } from './fixtures/travel.js';

const mockStore = () => {
  const pool = { execute: vi.fn().mockResolvedValue([[], []]), end: vi.fn(), destroy: vi.fn() };
  return { pool, store: new MysqlTripStore(pool as unknown as Pool) };
};

describe('MySQL 行程读写', () => {
  it('查询挂起时按期限销毁连接，避免后续请求排队等待', async () => {
    vi.useFakeTimers();
    try {
      const { pool, store } = mockStore();
      pool.execute.mockImplementation(() => new Promise(() => {}));
      const result = expect(store.list()).rejects.toMatchObject({ statusCode: 503 });
      await vi.advanceTimersByTimeAsync(config.MYSQL_QUERY_TIMEOUT_MS);
      await result;
      expect(pool.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('历史只读取轻量字段，兼容 JSON 对象和字符串，并保留 UTC 毫秒时间', async () => {
    const { pool, store } = mockStore();
    const trip = TripSchema.parse(tripFixture());
    trip.createdAt = '2026-10-13T00:00:00.123Z';
    pool.execute.mockResolvedValueOnce([
      [
        {
          id: trip.id,
          city: JSON.stringify(trip.city),
          title: trip.routes[0]!.title,
          days: trip.request.days,
          summary: trip.summary,
          created_at: new Date(trip.createdAt),
        },
      ],
      [],
    ]);
    expect(await store.list()).toEqual([
      {
        id: trip.id,
        city: trip.city,
        title: trip.routes[0]!.title,
        days: trip.request.days,
        summary: trip.summary,
        createdAt: trip.createdAt,
      },
    ]);
    const options = pool.execute.mock.calls[0]![0];
    expect(options.sql).not.toMatch(/payload|SELECT \*/i);
    expect(options.sql).toContain('ORDER BY updated_at DESC, id DESC LIMIT 30');
    expect(options.timeout).toBe(config.MYSQL_QUERY_TIMEOUT_MS);
    pool.execute.mockResolvedValueOnce([[{ payload: JSON.stringify(trip) }], []]);
    expect(await store.get(trip.id)).toEqual(trip);
    expect(pool.execute.mock.calls[1]![0].values).toEqual([trip.id]);
  });

  it('一次 upsert 同步摘要和详情，修改时不会留下旧城市或旧天数', async () => {
    const { pool, store } = mockStore();
    const trip = TripSchema.parse(tripFixture());
    trip.city.name = '修改后的城市';
    trip.request.days = 3;
    trip.summary = '修改后的摘要';
    await store.save(trip);
    expect(pool.execute).toHaveBeenCalledTimes(1);
    const options = pool.execute.mock.calls[0]![0];
    expect(options.sql).toContain('city=VALUES(city), days=VALUES(days)');
    expect(options.values).toEqual([
      trip.id,
      trip.routes[0]!.title,
      JSON.stringify(trip.city),
      3,
      trip.summary,
      JSON.stringify(trip),
      new Date(trip.createdAt),
      new Date(trip.updatedAt),
    ]);
  });

  it('非法 ID 和无效时间不访问数据库；数据库异常返回可展示的 503', async () => {
    const { pool, store } = mockStore();
    expect(await store.get('../outside')).toBeNull();
    await expect(store.save({ ...tripFixture(), updatedAt: 'invalid' })).rejects.toThrow(
      '行程时间无效',
    );
    expect(pool.execute).not.toHaveBeenCalled();
    pool.execute.mockRejectedValue(new Error('sensitive connection details'));
    for (const operation of [
      () => store.get(tripFixture().id),
      () => store.list(),
      () => store.save(tripFixture()),
    ])
      await expect(operation()).rejects.toMatchObject({
        statusCode: 503,
        code: 'STORAGE_UNAVAILABLE',
      });
    expect(await store.check()).toBe(false);
  });
});
