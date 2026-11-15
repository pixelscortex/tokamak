export function completionChunk(text: string) {
  return `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1,
    model: "mock", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
}

export function completionEnd() {
  return `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1,
    model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
}
