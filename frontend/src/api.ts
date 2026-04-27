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

export function fetchLesson(topic: string) {
  return post<{ lesson: string }>('/api/teach', { topic })
}

export function fetchQuestion(topic: string) {
  return post<{
    question: string
    options: string[]
    correct_index: number
    explanation: string
  }>('/api/question', { topic })
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
