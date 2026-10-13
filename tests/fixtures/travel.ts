import { randomUUID } from 'node:crypto';
import type { AgentPlan, PlanRequest, Poi, Region, Trip } from '@stree/shared';
export const city: Region = {
  name: '杭州市',
  adcode: '330100',
  level: 'city',
  center: { longitude: 120.15, latitude: 30.27 },
};
export const province: Region = { ...city, name: '浙江省', adcode: '330000', level: 'province' };
export const request: PlanRequest = {
  provinceCode: '330000',
  cityCode: '330100',
  days: 2,
  budget: 1500,
  startDate: '2026-11-01',
  origin: '杭州站',
  mustVisit: [],
  interests: ['城市漫步'],
  pace: 'balanced',
  transport: 'transit',
  includeHotel: true,
  message: '轻松游览杭州，安排相邻景点并提供游玩攻略。',
};
export const poi = (id: string, name = id, hotel = false): Poi => ({
  id,
  name,
  address: '测试地址',
  district: '西湖区',
  adcode: '330106',
  location: { longitude: 120.15 + id.length * 0.001, latitude: 30.27 },
  category: hotel ? '住宿服务;宾馆酒店' : '风景名胜',
  phone: null,
  openingHours: null,
  referencePrice: null,
  source: 'amap',
  fetchedAt: '2026-10-13T00:00:00Z',
});
export const places = [
  poi('lake', '测试西湖'),
  poi('museum', '测试博物馆'),
  poi('park', '测试公园'),
  poi('hotel', '测试酒店', true),
];
export const guide = {
  introduction: '沿着湖边慢慢走，留意这里的景观与当地生活。',
  highlights: ['沿岸景观'],
  tips: ['留出休息时间'],
  reservation: '开放时间与预约需以官方当日信息确认',
  photography: '注意逆光角度',
};
export const agentPlan = (): AgentPlan => ({
  summary: '围绕西湖与博物馆安排两天顺路行程，每站都有游玩攻略。',
  routes: [
    {
      id: 'relaxed',
      title: '湖畔慢游',
      label: '轻松漫步',
      summary: '以湖畔景观和城市文化为主题，留出充分时间停留。',
      suitableFor: '喜欢城市漫步的人',
      estimatedFoodBudget: 180,
      estimatedTicketBudget: 100,
      estimatedHotelBudget: 220,
      days: [
        {
          day: 1,
          title: '湖畔的一天',
          overview: '沿着湖边看看风景，下午走进博物馆。',
          stops: [
            {
              poiId: 'lake',
              arrival: '09:00',
              departure: '11:00',
              kind: 'attraction',
              reason: '先体验湖畔的景观与日常生活',
              guide,
            },
            {
              poiId: 'museum',
              arrival: '11:00',
              departure: '12:30',
              kind: 'attraction',
              reason: '了解城市历史并留出室内休息时间',
              guide,
            },
          ],
          hotelPoiId: 'hotel',
          hotelReason: '靠近当日最后一站，减少往返',
          foodTips: ['午餐可在周边寻找当地面馆'],
        },
        {
          day: 2,
          title: '公园的一天',
          overview: '在公园放慢脚步，下午返程。',
          stops: [
            {
              poiId: 'park',
              arrival: '10:00',
              departure: '12:00',
              kind: 'attraction',
              reason: '在公园中放松并结束这次旅行',
              guide,
            },
          ],
          hotelPoiId: null,
          hotelReason: '',
          foodTips: ['尝试当地早餐'],
        },
      ],
      guide: {
        overview: '这份攻略围绕本次湖畔与博物馆行程编写，适合慢慢逛。',
        beforeYouGo: ['确认开放与预约信息'],
        localTips: ['为天气变化留出机动时间'],
        packingList: ['舒适的鞋'],
      },
      caveats: ['门票与房价均为估算，需要核实。'],
    },
  ],
});
export const tripFixture = (): Trip => {
  const plan = agentPlan();
  const route = plan.routes[0]!;
  return {
    id: randomUUID(),
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    province,
    city,
    origin: { name: '杭州站', location: city.center },
    request,
    summary: plan.summary,
    engine: 'codex-app-server',
    model: 'test-model',
    threadId: 'test-thread',
    routes: [
      {
        ...route,
        days: route.days.map((day, index) => ({
          ...day,
          date: `2026-11-0${index + 1}`,
          stops: day.stops.map((stop) => ({
            ...stop,
            poi: places.find((p) => p.id === stop.poiId)!,
          })),
          hotel: day.hotelPoiId ? places.find((p) => p.id === day.hotelPoiId)! : null,
          segments: day.stops.map((stop) => ({
            from: '测试出发地',
            to: places.find((p) => p.id === stop.poiId)!.name,
            mode: 'transit',
            durationMinutes: 20,
            distanceMeters: 2400,
            price: 3,
            summary: '测试交通线路',
            polyline: [city.center, { longitude: 120.16, latitude: 30.28 }],
            source: 'amap',
          })),
          distanceMeters: 4800,
          transitMinutes: 40,
        })),
        totalEstimatedBudget: 509,
        transportCost: 9,
        distanceMeters: 9600,
        transitMinutes: 80,
        warnings: [],
      },
    ],
  };
};
