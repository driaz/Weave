export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY not configured on server' },
      { status: 500 },
    )
  }

  try {
    const body = await req.text()

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    })

    const data = await response.text()

    return new Response(data, {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })
  } catch (error) {
    return Response.json(
      { error: 'Proxy request failed' },
      { status: 502 },
    )
  }
}

export const config = {
  path: '/api/claude',
}
