import { z } from 'zod';

// openapi LoginRequest: loginId 1-100、password 8-128、additionalProperties:false。文字列trim（API設計書）。
export const loginRequestSchema = z
  .object({
    loginId: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(128),
  })
  .strict();

export type LoginRequestInput = z.infer<typeof loginRequestSchema>;
