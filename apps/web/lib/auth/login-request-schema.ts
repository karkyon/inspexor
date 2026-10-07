import { z } from 'zod';

// API-001 POST /auth/login の LoginRequest。未知field拒否（.strict）、文字列trim。
export const loginRequestSchema = z
  .object({
    loginId: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginRequestInput = z.infer<typeof loginRequestSchema>;
