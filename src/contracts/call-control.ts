/** Contracts for holding, resuming and transferring a live call (POST /api/calls/:ref/hold|resume|transfer). */
import { z } from "zod";

export const transferBodySchema = z.object({ to: z.string().trim().min(1).max(40) });
export type TransferBody = z.infer<typeof transferBodySchema>;

/** The call's hold and transfer state after the request. */
export const callControlResultSchema = z.object({
  id: z.string(),
  onHold: z.boolean(),
  transferredTo: z.string().nullable(),
});
export type CallControlResult = z.infer<typeof callControlResultSchema>;
