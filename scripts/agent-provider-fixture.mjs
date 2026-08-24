import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.AGENT_FIXTURE_PORT ?? 5180);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function event(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "fixture_route_not_found" }));
    return;
  }
  const request = await body(req);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const hasToolResult = messages.some((message) => message?.role === "tool");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close" });
  if (!hasToolResult) {
    event(res, { id: "fixture-turn-1", model: request.model, choices: [{ delta: { tool_calls: [{ index: 0, id: "fixture-call-1", type: "function", function: { name: "get_build_evaluation", arguments: "{\"sections\":[\"findings\",\"power\"]}" } }] }, finish_reason: null }] });
    event(res, { id: "fixture-turn-1", model: request.model, choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 64, completion_tokens: 12, total_tokens: 76, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 56 } });
  } else {
    event(res, { id: "fixture-turn-2", model: request.model, choices: [{ delta: { content: "Fixture 已读取服务端 BuildEvaluation。" }, finish_reason: null }] });
    event(res, { id: "fixture-turn-2", model: request.model, choices: [{ delta: { content: "当前结论仅用于浏览器端到端测试，不代表真实 DeepSeek 响应。" }, finish_reason: "stop" }], usage: { prompt_tokens: 96, completion_tokens: 24, total_tokens: 120, prompt_cache_hit_tokens: 16, prompt_cache_miss_tokens: 80 } });
  }
  res.end("data: [DONE]\n\n");
});

server.listen(port, host, () => console.log(`Agent provider fixture listening on http://${host}:${port}`));
