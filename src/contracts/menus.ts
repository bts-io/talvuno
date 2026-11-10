/**
 * Phone menu contracts: an optional spoken menu per number. The caller presses a key, and each key rings the
 * app, goes to voicemail or forwards to a number the owner typed. No key, or a key with nothing behind it,
 * repeats the prompt once and then takes the default action.
 */
import { z } from "zod";
import { isE164 } from "../lib/phone";
import { idSchema } from "./index";

export const MENU_PROMPT_MAX = 500;
export const MENU_KEYS_MAX = 9;
/** The keys a menu can use. 0, * and # are left free. */
export const MENU_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export const MENU_ACTIONS = ["ring", "voicemail", "forward"] as const;
/** What happens after the prompt played twice with no usable key. Never a forward. */
export const MENU_DEFAULT_ACTIONS = ["ring", "voicemail"] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];
export type MenuDefaultAction = (typeof MENU_DEFAULT_ACTIONS)[number];

const digitSchema = z.enum(MENU_DIGITS);

export const menuKeySchema = z.discriminatedUnion("action", [
  z.object({ digit: digitSchema, action: z.literal("ring") }).strict(),
  z.object({ digit: digitSchema, action: z.literal("voicemail") }).strict(),
  z
    .object({
      digit: digitSchema,
      action: z.literal("forward"),
      to: z.string().trim().refine(isE164, { message: "Enter the number in full international form" }),
    })
    .strict(),
]);
export type MenuKey = z.infer<typeof menuKeySchema>;

/** The keys of one menu: at most nine, each digit used once. */
export const menuKeysSchema = z
  .array(menuKeySchema)
  .max(MENU_KEYS_MAX)
  .refine((keys) => new Set(keys.map((k) => k.digit)).size === keys.length, {
    message: "Each key can only be used once",
  });

export const menuPromptSchema = z.string().trim().max(MENU_PROMPT_MAX);

export const numberMenuInputSchema = z
  .object({
    enabled: z.boolean(),
    prompt: menuPromptSchema,
    keys: menuKeysSchema,
    defaultAction: z.enum(MENU_DEFAULT_ACTIONS),
  })
  .strict()
  .refine((m) => !m.enabled || (m.prompt.length > 0 && m.keys.length > 0), {
    message: "A menu that is on needs a prompt and at least one key",
  });
export type NumberMenuInput = z.input<typeof numberMenuInputSchema>;

export const numberMenuSchema = z.object({
  numberId: idSchema,
  enabled: z.boolean(),
  prompt: z.string(),
  keys: z.array(menuKeySchema),
  defaultAction: z.enum(MENU_DEFAULT_ACTIONS),
});
export type NumberMenu = z.infer<typeof numberMenuSchema>;

export const menuPreviewInputSchema = z.object({ prompt: menuPromptSchema }).strict();
