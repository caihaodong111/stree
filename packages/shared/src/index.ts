import { z } from 'zod';

export const TravelModeSchema = z.enum(['walking', 'transit', 'driving', 'cycling']);
export const CoordinateSchema = z.object({
  longitude: z.number().min(73).max(136),
  latitude: z.number().min(3).max(54),
});
export const RegionSchema = z.object({
  name: z.string(),
  adcode: z.string().regex(/^\d{6}$/),
  center: CoordinateSchema,
  level: z.enum(['province', 'city']),
});
export type Region = z.infer<typeof RegionSchema>;
export type Coordinate = z.infer<typeof CoordinateSchema>;
export type TravelMode = z.infer<typeof TravelModeSchema>;

export const LocatedRegionSchema = z.object({
  province: RegionSchema,
  city: RegionSchema,
});
export type LocatedRegion = z.infer<typeof LocatedRegionSchema>;

export const PlanRequestSchema = z.object({
  provinceCode: z.string().regex(/^\d{6}$/),
  cityCode: z.string().regex(/^\d{6}$/),
  days: z.number().int().min(1).max(7),
  budget: z.number().min(100).max(100000).nullable(),
  startDate: z.iso.date().nullable(),
  origin: z.string().max(100).default(''),
  originPoiId: z.string().trim().min(1).max(100).nullable().optional(),
  mustVisit: z.array(z.string().trim().min(1).max(60)).max(10),
  mustVisitPlaces: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(60),
      }),
    )
    .max(10)
    .optional(),
  interests: z.array(z.string().max(30)).max(8),
  pace: z.enum(['relaxed', 'balanced', 'packed']),
  transport: TravelModeSchema,
  includeHotel: z.boolean(),
  message: z.string().trim().min(2).max(2000),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export const PoiSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  district: z.string(),
  adcode: z.string(),
  location: CoordinateSchema,
  category: z.string(),
  phone: z.string().nullable(),
  openingHours: z.string().nullable(),
  referencePrice: z.number().nonnegative().nullable(),
  source: z.literal('amap'),
  fetchedAt: z.string(),
});
export type Poi = z.infer<typeof PoiSchema>;

export const PlaceSuggestionSchema = PoiSchema.pick({
  id: true,
  name: true,
  address: true,
  district: true,
  adcode: true,
  location: true,
});
export type PlaceSuggestion = z.infer<typeof PlaceSuggestionSchema>;

export const StopGuideSchema = z.object({
  introduction: z.string().min(10),
  highlights: z.array(z.string().min(2)).min(1).max(5),
  tips: z.array(z.string().min(2)).min(1).max(5),
  reservation: z.string().min(2),
  photography: z.string(),
});
export const AgentStopSchema = z.object({
  poiId: z.string(),
  arrival: z.string().regex(/^\d{2}:\d{2}$/),
  departure: z.string().regex(/^\d{2}:\d{2}$/),
  kind: z.enum(['attraction', 'meal', 'neighborhood']),
  reason: z.string(),
  guide: StopGuideSchema,
});
export const AgentLegSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  mode: TravelModeSchema,
  reason: z.string(),
  durationMinutes: z
    .number()
    .nonnegative()
    .describe('AI 给出的该段交通耗时；可参考地图工具，未知时给出估算'),
  distanceMeters: z.number().nonnegative().describe('AI 给出的距离，单位米；未知时给出估算'),
  price: z.number().nonnegative().nullable(),
  summary: z.string().describe('该段出行安排；没有地图数据时明确标注为 AI 估算'),
});
export const AgentRouteSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  title: z.string(),
  label: z.string(),
  summary: z.string(),
  suitableFor: z.string(),
  estimatedFoodBudget: z.number().nonnegative(),
  estimatedTicketBudget: z.number().nonnegative(),
  estimatedHotelBudget: z.number().nonnegative(),
  totalEstimatedBudget: z.number().nonnegative(),
  transportCost: z.number().nonnegative(),
  distanceMeters: z.number().nonnegative(),
  transitMinutes: z.number().nonnegative(),
  warnings: z.array(z.string()),
  days: z
    .array(
      z.object({
        day: z.number().int().positive(),
        title: z.string(),
        overview: z.string(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        stops: z.array(AgentStopSchema).min(1),
        legs: z.array(AgentLegSchema),
        distanceMeters: z.number().nonnegative(),
        transitMinutes: z.number().nonnegative(),
        hotelPoiId: z.string().nullable(),
        hotelReason: z.string(),
        foodTips: z.array(z.string()),
      }),
    )
    .min(1),
  guide: z.object({
    overview: z.string(),
    beforeYouGo: z.array(z.string()).min(1),
    localTips: z.array(z.string()).min(1),
    packingList: z.array(z.string()),
  }),
  caveats: z.array(z.string()),
});
export const AgentPlanSchema = z.object({
  summary: z.string(),
  routes: z.array(AgentRouteSchema).min(1),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;
export type AgentRoute = z.infer<typeof AgentRouteSchema>;

export const DirectionStepSchema = z.object({
  mode: z.enum(['walking', 'driving', 'cycling', 'bus', 'subway', 'railway', 'taxi']),
  instruction: z.string(),
  instructions: z.array(z.string()).optional(),
  name: z.string(),
  distanceMeters: z.number().nonnegative().nullable(),
  durationMinutes: z.number().nonnegative().nullable(),
  departureStop: z.string().optional(),
  arrivalStop: z.string().optional(),
  stopCount: z.number().nonnegative().optional(),
  viaStops: z.array(z.string()).optional(),
  entrance: z.string().optional(),
  exit: z.string().optional(),
  polyline: z.array(CoordinateSchema),
});
export type DirectionStep = z.infer<typeof DirectionStepSchema>;
export const RoutePointSchema = z.object({
  name: z.string(),
  location: CoordinateSchema,
  id: z.string().optional(),
  adcode: z.string().optional(),
});
export type RoutePoint = z.infer<typeof RoutePointSchema>;
export const SegmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: TravelModeSchema,
  durationMinutes: z.number().nonnegative(),
  distanceMeters: z.number().nonnegative(),
  price: z.number().nonnegative().nullable(),
  summary: z.string(),
  polyline: z.array(CoordinateSchema),
  source: z.enum(['amap', 'ai']),
  origin: RoutePointSchema.optional(),
  destination: RoutePointSchema.optional(),
  steps: z.array(DirectionStepSchema).optional(),
  walkingDistanceMeters: z.number().nonnegative().nullable().optional(),
  transfers: z.number().nonnegative().optional(),
  trafficLights: z.number().nonnegative().nullable().optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;
export const DirectionsResponseSchema = z.object({
  routes: z.array(SegmentSchema),
  fetchedAt: z.string(),
});
export type DirectionsResponse = z.infer<typeof DirectionsResponseSchema>;
export const RouteSchema = AgentRouteSchema.extend({
  days: z.array(
    z.object({
      day: z.number(),
      title: z.string(),
      overview: z.string(),
      startTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      legs: z
        .array(
          AgentLegSchema.partial({
            durationMinutes: true,
            distanceMeters: true,
            price: true,
            summary: true,
          }),
        )
        .optional(),
      date: z.string().nullable(),
      stops: z.array(AgentStopSchema.extend({ poi: PoiSchema })),
      hotel: PoiSchema.nullable(),
      hotelReason: z.string(),
      foodTips: z.array(z.string()),
      segments: z.array(SegmentSchema),
      distanceMeters: z.number(),
      transitMinutes: z.number(),
    }),
  ),
  totalEstimatedBudget: z.number(),
  transportCost: z.number(),
  distanceMeters: z.number(),
  transitMinutes: z.number(),
  warnings: z.array(z.string()),
});
export type Route = z.infer<typeof RouteSchema>;
export const WebSourceSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    }),
  title: z.string(),
  snippet: z.string().optional(),
  publishedAt: z.string().optional(),
  query: z.string(),
  retrievedAt: z.string(),
});
export type WebSource = z.infer<typeof WebSourceSchema>;
export const TravelResearchSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed', 'not-used', 'not-configured', 'disabled']),
  sources: z.array(WebSourceSchema),
  warnings: z.array(z.string()),
});
export const TripSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  province: RegionSchema,
  city: RegionSchema,
  origin: RoutePointSchema,
  request: PlanRequestSchema,
  summary: z.string(),
  routes: z.array(RouteSchema),
  engine: z.enum(['codex-app-server', 'custom-provider']),
  model: z.string(),
  threadId: z.string(),
  research: TravelResearchSchema.optional(),
});
export type Trip = z.infer<typeof TripSchema>;
export { getSegmentEndpoints } from './routes.js';
export type TripSummary = Pick<Trip, 'id' | 'createdAt' | 'city' | 'summary'> & {
  title: string;
  days: number;
};
export type ProgressEvent = {
  type: 'progress';
  stage: 'places' | 'planning' | 'routing' | 'saving';
  message: string;
  timestamp: string;
};
export type JobEvent =
  | ProgressEvent
  | { type: 'result'; trip: Trip }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };
export type JobSnapshot = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  events: JobEvent[];
};
export type PlanningTaskSummary = {
  id: string;
  status: JobSnapshot['status'];
  request: PlanRequest;
  tripId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  progress: ProgressEvent | null;
  cityName: string;
};
export type TravelHistory = {
  trips: TripSummary[];
  tasks: PlanningTaskSummary[];
};
export type ServiceStatus = {
  codex: { available: boolean; authenticated: boolean; model: string | null; error?: string };
  model?: { configured: boolean; provider: string; model: string | null; error?: string };
  amap: { configured: boolean };
  storage: { driver: string; available: boolean };
  webSearch?: { enabled: boolean; configured: boolean; provider: string };
  version: string;
};

export const ModelSettingsSchema = z
  .object({
    model: z.string().trim().min(1).max(200).nullable(),
    effort: z.string().trim().min(1).max(30).nullable(),
    providerId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .optional(),
  })
  .strict();
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
export type ModelOption = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
export type ModelSettingsResponse = {
  settings: ModelSettings;
  effectiveModel: string | null;
  defaultModel: string | null;
  models: ModelOption[];
  providers?: ProviderSummary[];
  codexError?: string;
};

export const ProviderModelSchema = z.object({
  id: z.string().trim().min(1, '请填写模型 ID。').max(200),
  name: z.string().trim().max(100).default(''),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});
export const ProviderSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
        'Provider ID 需以小写字母开头，仅使用小写字母、数字和连字符。',
      )
      .max(60)
      .refine((value) => value !== 'codex', 'codex 是内置提供方，请使用其他 ID。'),
    name: z.string().trim().min(1, '请填写显示名称。').max(100),
    baseURL: z
      .string()
      .trim()
      .url('请填写完整的 API 地址。')
      .max(2000)
      .refine((value) => {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, 'API 地址需使用 HTTP 或 HTTPS，且不含账号、密码、查询参数或锚点。'),
    protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
    models: z
      .array(ProviderModelSchema)
      .min(1, '请至少添加一个模型。')
      .max(200)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        '模型 ID 不能重复。',
      ),
    maxOutputTokens: z.number().int().positive().nullable().default(null),
    jsonMode: z.boolean().default(false),
  })
  .strict();
export const ProviderInputSchema = ProviderSchema.extend({
  apiKey: z
    .string()
    .refine((value) => !value.length || Boolean(value.trim()), 'API 密钥不能只包含空白字符。')
    .trim()
    .max(4096)
    .refine(
      (value) => /^[\x21-\x7e]*$/.test(value),
      'API 密钥只能包含可打印的英文字符，不能包含空格、换行或中文。',
    )
    .optional(),
  clearApiKey: z.boolean().optional(),
}).strict();
export const ProviderProbeSchema = ProviderInputSchema.omit({ models: true }).partial({
  id: true,
  name: true,
});
export type Provider = z.infer<typeof ProviderSchema>;
export type ProviderInput = z.infer<typeof ProviderInputSchema>;
export type ProviderProbe = z.infer<typeof ProviderProbeSchema>;
export type ProviderSummary = Provider & { keyConfigured: boolean };
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
