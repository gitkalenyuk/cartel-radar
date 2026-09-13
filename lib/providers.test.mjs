// lib/providers.test.mjs — перевірки того, як застосунок поводиться з
// параметрами, які приймають не всі моделі.
//
// Привід: користувачі Moonshot (Kimi) отримували HTTP 400 «invalid
// temperature: only 1 is allowed for this model». Застосунок має помічати
// таку відмову, запам'ятовувати її й повторювати запит без проблемного
// параметра — а не показувати помилку користувачу.
//
// Запуск: node lib/providers.test.mjs

import { buildRequest, tweakForError, tweaksFor, setTweaks, clearTweaks, PROVIDER_PRESETS } from "./providers.mjs";

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name); }
}
function eq(name, got, want) { ok(`${name} → ${JSON.stringify(got)}`, JSON.stringify(got) === JSON.stringify(want)); }

const moonshot = PROVIDER_PRESETS.find((p) => p.id === "moonshot");
const openaiish = { id: "custom", apiStyle: "openai", baseURL: "https://example.com/v1", apiKey: "k" };
const msg = [{ role: "user", content: "привіт" }];
const opts = (model, p) => buildRequest(p, { model, messages: msg, temperature: 0.8, maxTokens: 100 }).body;

console.log("Правила для моделей Kimi");
eq("у пресеті Moonshot є правило для kimi", moonshot?.paramRules?.[0]?.omitTemperature, true);
ok("для kimi-k3 temperature НЕ надсилається", !("temperature" in opts("kimi-k3", moonshot)));
ok("для kimi-k2.6 temperature НЕ надсилається", !("temperature" in opts("kimi-k2.6", moonshot)));
ok("для moonshot-v1-128k temperature надсилається", "temperature" in opts("moonshot-v1-128k", moonshot));
eq("значення temperature не зіпсовано", opts("moonshot-v1-128k", moonshot).temperature, 0.8);

console.log("Розпізнавання відмов сервера");
eq("помилка Kimi про temperature",
  tweakForError('{"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}}'),
  { omitTemperature: true });
eq("помилка OpenAI про max_tokens",
  tweakForError("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."),
  { maxTokensField: "max_completion_tokens" });
eq("звичайна помилка не перетворюється на правило", tweakForError("model not found"), null);
eq("порожня відповідь не ламає розбір", tweakForError(""), null);

console.log("Вивчені правила застосовуються і до інших провайдерів");
clearTweaks();
ok("до вивчення temperature надсилається", "temperature" in opts("some-model", openaiish));
setTweaks("custom", "some-model", { omitTemperature: true });
ok("після вивчення — ні", !("temperature" in opts("some-model", openaiish)));
ok("інша модель того ж провайдера не зачеплена", "temperature" in opts("other-model", openaiish));
eq("tweaksFor показує правило", tweaksFor(openaiish, "some-model").omitTemperature, true);

console.log("Поле ліміту токенів");
clearTweaks();
setTweaks("custom", "reasoner", { maxTokensField: "max_completion_tokens" });
const b = opts("reasoner", openaiish);
ok("використовується max_completion_tokens", "max_completion_tokens" in b && !("max_tokens" in b));
eq("значення ліміту збережено", b.max_completion_tokens, 100);

console.log("Інші стилі API не зламані");
const anthropic = { id: "a", apiStyle: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKey: "k" };
ok("Anthropic і далі надсилає temperature", "temperature" in opts("claude", anthropic));
setTweaks("a", "claude", { omitTemperature: true });
ok("Anthropic поважає вивчене правило", !("temperature" in opts("claude", anthropic)));
const gemini = { id: "g", apiStyle: "gemini", baseURL: "https://x/v1beta", apiKey: "k" };
eq("Gemini кладе temperature в generationConfig", opts("gemini-3", gemini).generationConfig.temperature, 0.8);
setTweaks("g", "gemini-3", { omitTemperature: true });
ok("Gemini прибирає температуру з generationConfig", !("temperature" in opts("gemini-3", gemini).generationConfig));

clearTweaks();
console.log(`\n${failed ? "Є ПОМИЛКИ" : "УСІ ПЕРЕВІРКИ ПРОЙДЕНО"} (${passed})`);
process.exit(failed ? 1 : 0);
