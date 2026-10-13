import type { AiProviderDefinition } from "../types";
import { AIML_KEYS_URL, AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "../aimlapi-types";

export const AIMLAPI_PROVIDER: AiProviderDefinition = {
  key: AIML_PROVIDER_KEY,
  name: AIML_PROVIDER_NAME,
  description: "One OpenAI-compatible API key for hundreds of models from OpenAI, Google, Anthropic, DeepSeek and others.",
  websiteUrl: "https://aimlapi.com",
  iconText: "AI",
  iconBackground: "#0F172A",
  auth: {
    fields: [
      { key: "apiKey", label: "AI/ML API key", placeholder: "Your AI/ML API key", inputType: "password", required: true },
    ],
    helpUrl: AIML_KEYS_URL,
  },
  // Models come from the live catalog (structured-output chat models only), like OpenRouter's.
  models: [],
};
