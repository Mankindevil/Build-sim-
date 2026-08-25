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

function claudeEvent(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !["/chat/completions", "/v1/messages"].includes(req.url ?? "")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "fixture_route_not_found" }));
    return;
  }
  const request = await body(req);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const hasToolResult = messages.some((message) => message?.role === "tool" || (Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_result")));
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close" });
  if (req.url === "/v1/messages") {
    claudeEvent(res, "message_start", { type: "message_start", message: { id: hasToolResult ? "fixture-claude-turn-2" : "fixture-claude-turn-1", model: request.model, usage: { input_tokens: hasToolResult ? 96 : 64, cache_read_input_tokens: hasToolResult ? 16 : 8, cache_creation_input_tokens: hasToolResult ? 80 : 56, output_tokens: 1 } } });
    if (!hasToolResult) {
      claudeEvent(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "fixture-claude-call-1", name: "get_build_evaluation", input: {} } });
      claudeEvent(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"sections\":[\"findings\",\"power\"]}" } });
      claudeEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      claudeEvent(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } });
    } else {
      claudeEvent(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      claudeEvent(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude fixture 已读取服务端 BuildEvaluation。" } });
      claudeEvent(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "这只验证 Provider 适配边界，不代表 live Claude 响应。" } });
      claudeEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      claudeEvent(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 24 } });
    }
    claudeEvent(res, "message_stop", { type: "message_stop" });
    res.end();
    return;
  }
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
