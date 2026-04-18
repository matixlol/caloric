type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export async function handleHealthRequest(): Promise<Response> {
  return json({ ok: true });
}
