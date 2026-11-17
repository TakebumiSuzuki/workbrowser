import { z } from 'zod';

export const AGENT_TOOLS = ['snapshot', 'read', 'find', 'screenshot', 'navigate', 'click', 'set', 'fill_form', 'type', 'press', 'hover', 'scroll', 'wait', 'remember', 'done'] as const;
export const CallSchema = z.strictObject({
  name: z.enum(AGENT_TOOLS), args: z.record(z.string(), z.unknown()), id: z.string().max(200).optional(),
});
// Preserve opaque Gemini signatures unchanged across function-call turns. Model output cannot contain images or code.
export const ModelContentSchema = z.strictObject({
  role: z.literal('model'),
  parts: z.array(z.strictObject({
    text: z.string().max(60000).optional(), thought: z.boolean().optional(),
    thoughtSignature: z.string().max(100000).optional(), functionCall: CallSchema.optional(),
  })).min(1).max(32),
});
export const ImageSchema = z.strictObject({
  mimeType: z.enum(['image/png', 'image/jpeg']),
  base64: z.string().min(4).max(900000).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0, 'Invalid base64 length.'),
  width: z.number().int().positive().max(1600), height: z.number().int().positive().max(1600),
});
export const ObservationSchema = z.strictObject({
  url: z.string().max(4000), text: z.string().max(24000), image: ImageSchema.optional(),
});
export const ToolReplySchema = z.strictObject({
  name: z.enum(AGENT_TOOLS), id: z.string().max(200).optional(),
  ok: z.boolean(), text: z.string().max(24000), url: z.string().max(4000).optional(),
  image: ImageSchema.optional(),
}).refine(value => !value.image || !!value.url, 'An image requires its source URL.');
export const ExchangeSchema = z.strictObject({
  model: ModelContentSchema, results: z.array(ToolReplySchema).min(1).max(16),
});
export const ConversationTurnSchema = z.strictObject({
  prompt: z.string().max(8000), answer: z.string().max(50000),
  notes: z.string().max(20000), activity: z.string().max(24000),
  sources: z.array(z.string().max(4000)).max(500),
  status: z.enum(['completed', 'stopped', 'failed', 'interrupted']),
});
export const AgentRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(8000), currentUrl: z.string().max(4000),
  initial: ObservationSchema.optional(), notes: z.string().max(20000),
  history: z.array(ExchangeSchema).max(500), sources: z.array(z.string().max(4000)).max(500),
  conversation: z.array(ConversationTurnSchema).max(20).optional(),
  finishOnly: z.boolean().default(false),
});
export const AgentTurnSchema = z.strictObject({ content: ModelContentSchema });
export const DoneSchema = z.strictObject({
  outcome: z.enum(['success', 'partial', 'failed']), answer: z.string().trim().min(1).max(50000),
});
export const RememberSchema = z.strictObject({ notes: z.string().min(1).max(20000) });
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type AgentImage = z.infer<typeof ImageSchema>;
export type AgentTurn = z.infer<typeof AgentTurnSchema>;
export type AgentCall = z.infer<typeof CallSchema>;
export type ToolReply = z.infer<typeof ToolReplySchema>;
export type Done = z.infer<typeof DoneSchema>;
export interface AgentInfo { provider: 'vertex' | 'gemini' | 'unconfigured'; model: string; configured: boolean }
