/* A worker that exists only to put a prompt in front of the real model and
   hand back exactly what came out. Run by hand, never deployed.

   Separate from `src/index.ts` on purpose. The app's `/generate` is behind
   Turnstile and two rate limits, which are correct for a public endpoint and
   useless when the thing being tested is a prompt. Adding a bypass to the real
   worker would put a hole in a public app to save a file.

   The prompt arrives in the request rather than being built here, so iterating
   on wording costs a POST rather than a worker restart. */

interface Env {
  AI: {
    /* `response` is a string on most models and an object on some, and a
       reasoning model puts its answer somewhere else again. Typed as unknown
       so the probe reports the shape rather than crashing on it, which is a
       thing that only shows up when you point this at a second model. */
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST")
      return new Response("POST a prompt", { status: 405 });

    const body = (await req.json()) as {
      model: string;
      prompt: string;
      schema?: Record<string, unknown>;
      temperature?: number;
      max_tokens?: number;
    };

    const input: Record<string, unknown> = {
      messages: [{ role: "user", content: body.prompt }],
      temperature: body.temperature ?? 0.2,
      max_tokens: body.max_tokens ?? 1024,
    };
    if (body.schema) {
      input.response_format = { type: "json_schema", json_schema: body.schema };
    }

    const started = Date.now();
    try {
      const out = (await env.AI.run(body.model, input)) as {
        response?: unknown;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        /* Reasoning models answer in OpenAI's shape instead, and put their
           thinking in `reasoning_content` and the actual answer in `content`.
           Gemma 4 spent all 2048 tokens reasoning and returned an empty
           `content`, which the probe first reported as "no reply" without
           saying why. */
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; reasoning_content?: string };
        }>;
      };
      const choice = out?.choices?.[0];
      const response = out?.response ?? choice?.message?.content;
      return Response.json({
        ok: true,
        ms: Date.now() - started,
        /* The tokens the model actually billed, which is the only honest input
           to the daily ceiling section 7 has owed since B3. Estimating token
           counts for Persian would be guessing twice: once at the tokenizer
           and once at the rate. */
        usage: out?.usage ?? null,
        reply:
          typeof response === "string"
            ? response
            : JSON.stringify(response ?? out),
        /* Kept so an unfamiliar shape is visible rather than merely empty: the
           first run against a reasoning model returned "" and the reason was
           not in anything the probe printed. `reasoning` is the token count
           spent thinking, which is the number that makes a cheap-looking
           reasoning model expensive: thinking is billed as output. */
        shape: typeof response,
        finish: choice?.finish_reason ?? null,
        reasoning: (choice?.message?.reasoning_content ?? "").length,
      });
    } catch (err) {
      return Response.json({
        ok: false,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
