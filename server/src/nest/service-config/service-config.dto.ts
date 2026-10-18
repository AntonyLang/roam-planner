import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
const endpoint = z.string().url().refine(value => {
  const u = new URL(value);
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
}, '连接地址须为不含密码或查询参数的 HTTP(S) 地址');
const secret = z.string().max(16384).nullable().optional();
export const serviceConfigPatch = z.object({
  model: z.object({ base_url: endpoint.optional(), model_id: z.string().trim().min(1).max(150).optional(),
    thinking_level: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(), api_key: secret }).strict().optional(),
  maps: z.object({ provider: z.enum(['amap', 'geoapify']).optional(), amap_key: secret, geoapify_key: secret }).strict().optional(),
  search: z.object({ exa_mcp_url: endpoint.or(z.literal('')).optional() }).strict().optional(),
  xhs: z.object({ enabled: z.boolean().optional() }).strict().optional(),
}).strict();
export type ConfigPatch = z.infer<typeof serviceConfigPatch>;
export class ServiceConfigDto extends createZodDto(serviceConfigPatch) {}
export class ServiceCheckDto extends createZodDto(z.object({
  service: z.enum(['model', 'maps', 'search', 'xhs']), config: serviceConfigPatch.optional(),
}).strict()) {}
