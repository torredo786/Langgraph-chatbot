export async function fetchConfig(): Promise<{ tavily_available: boolean }> {
  const res = await fetch('/api/config')
  if (!res.ok) return { tavily_available: false }
  return res.json()
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(err.detail ?? 'Request failed')
  }
  return res.json()
}

const STATUS_PREFIX = '__STATUS__:'

export async function fetchLesson(
  topic: string,
  searchMode: string,
  onStatus: (msg: string) => void,
  onToken: (text: string) => void,
): Promise<void> {
  const res = await fetch('/api/teach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, search_mode: searchMode }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(err.detail ?? 'Request failed')
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Process complete lines for status messages; pass the rest as tokens
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith(STATUS_PREFIX)) {
        onStatus(line.slice(STATUS_PREFIX.length).trim())
      } else if (line) {
        onToken(line + '\n')
      }
    }
  }

  // Flush any remaining content that didn't end with \n
  if (buffer) {
    if (buffer.startsWith(STATUS_PREFIX)) {
      onStatus(buffer.slice(STATUS_PREFIX.length).trim())
    } else {
      onToken(buffer)
    }
  }
}

export function fetchQuestion(topic: string, searchMode: string) {
  return post<{
    question: string
    options: string[]
    correct_index: number
    explanation: string
  }>('/api/question', { topic, search_mode: searchMode })
}

export function fetchEvaluation(
  selected_index: number,
  correct_index: number,
  explanation: string,
) {
  return post<{ feedback: string }>('/api/evaluate', {
    selected_index,
    correct_index,
    explanation,
  })
}
