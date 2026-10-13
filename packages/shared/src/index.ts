import { z } from 'zod';

export const TravelModeSchema = z.enum(['walking', 'transit', 'driving']);
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

export const PlanRequestSchema = z.object({
  provinceCode: z.string().regex(/^\d{6}$/),
  cityCode: z.string().regex(/^\d{6}$/),
  days: z.number().int().min(1).max(7),
  budget: z.number().min(100).max(100000).nullable(),
  startDate: z.iso.date().nullable(),
  origin: z.string().max(100).default(''),
  mustVisit: z.array(z.string().trim().min(1).max(60)).max(10),
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
  reason: z.string().min(5),
  guide: StopGuideSchema,
});
export const AgentRouteSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  title: z.string().min(2).max(60),
  label: z.string().min(2).max(20),
  summary: z.string().min(10),
  suitableFor: z.string(),
  estimatedFoodBudget: z.number().nonnegative(),
  estimatedTicketBudget: z.number().nonnegative(),
  estimatedHotelBudget: z.number().nonnegative(),
  days: z
    .array(
      z.object({
        day: z.number().int().min(1).max(7),
        title: z.string(),
        overview: z.string(),
        stops: z.array(AgentStopSchema).min(1).max(8),
        hotelPoiId: z.string().nullable(),
        hotelReason: z.string(),
        foodTips: z.array(z.string()).max(5),
      }),
    )
    .min(1)
    .max(7),
  guide: z.object({
    overview: z.string().min(10),
    beforeYouGo: z.array(z.string()).min(1).max(6),
    localTips: z.array(z.string()).min(1).max(6),
    packingList: z.array(z.string()).max(8),
  }),
  caveats: z.array(z.string()).max(10),
});
export const AgentPlanSchema = z.object({
  summary: z.string().min(10),
  routes: z.array(AgentRouteSchema).min(1).max(3),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;
export type AgentRoute = z.infer<typeof AgentRouteSchema>;

export const SegmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: TravelModeSchema,
  durationMinutes: z.number().nonnegative(),
  distanceMeters: z.number().nonnegative(),
  price: z.number().nonnegative().nullable(),
  summary: z.string(),
  polyline: z.array(CoordinateSchema),
  source: z.literal('amap'),
});
export type Segment = z.infer<typeof SegmentSchema>;
export const RouteSchema = AgentRouteSchema.extend({
  days: z.array(
    z.object({
      day: z.number(),
      title: z.string(),
      overview: z.string(),
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
export const TripSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  province: RegionSchema,
  city: RegionSchema,
  origin: z.object({ name: z.string(), location: CoordinateSchema }),
  request: PlanRequestSchema,
  summary: z.string(),
  routes: z.array(RouteSchema),
  engine: z.literal('codex-app-server'),
  model: z.string(),
  threadId: z.string(),
});
export type Trip = z.infer<typeof TripSchema>;
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
export type ServiceStatus = {
  codex: { available: boolean; authenticated: boolean; model: string | null; error?: string };
  amap: { configured: boolean };
  storage: { driver: string; available: boolean };
  version: string;
};
