import { Router } from "express";
import { z } from "zod";
import { currentOwnerId } from "../../auth/runtime-auth.js";
import { createDefaultPromptSettings } from "../../runtime/prompt-compiler.js";
import type { PromptSettingsRepository } from "../../repositories/prompt-settings-repository.js";
import { ApiError } from "../common/api-error.js";
import { validate, validated } from "../common/validation.js";

const blockSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(80),
  text: z.string().max(30_000),
  enabled: z.boolean(),
}).strict();

const settingsSchema = z.object({
  revision: z.number().int().min(0),
  blocks: z.array(blockSchema).max(40),
}).strict().superRefine(({ blocks }, context) => {
  const ids = new Set<string>();
  let totalChars = 0;
  for (const [index, block] of blocks.entries()) {
    if (ids.has(block.id)) context.addIssue({ code: "custom", path: ["blocks", index, "id"], message: "Block IDs must be unique." });
    ids.add(block.id);
    totalChars += block.text.length;
  }
  if (totalChars > 120_000) context.addIssue({ code: "custom", path: ["blocks"], message: "Prompt text is too large." });
});

type SettingsBody = z.infer<typeof settingsSchema>;
export function createPromptSettingsRoutes(repository: PromptSettingsRepository): Router {
  const routes = Router();
  routes.get("/defaults", (_request, response) => {
    response.json(createDefaultPromptSettings());
  });
  routes.get("/", (_request, response) => {
    response.json(repository.getPromptSettings(currentOwnerId(response)) ?? createDefaultPromptSettings());
  });
  routes.put("/", validate("body", settingsSchema), (_request, response) => {
    const ownerId = currentOwnerId(response);
    const body = validated<SettingsBody>(response, "body");
    const saved = repository.savePromptSettings(ownerId, body.revision, body.blocks);
    if (!saved) throw new ApiError(409, "prompt_settings_conflict", "Prompt settings changed. Reload and try again.");
    response.json(saved);
  });
  return routes;
}
