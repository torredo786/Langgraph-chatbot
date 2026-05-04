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
  difficulty: string,
  onStatus: (msg: string) => void,
  onToken: (text: string) => void,
): Promise<void> {
  const res = await fetch('/api/teach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, search_mode: searchMode, difficulty }),
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

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith(STATUS_PREFIX)) {
        onStatus(line.slice(STATUS_PREFIX.length).trim())
      } else {
        onToken(line + '\n')
      }
    }
  }

  if (buffer) {
    if (buffer.startsWith(STATUS_PREFIX)) {
      onStatus(buffer.slice(STATUS_PREFIX.length).trim())
    } else {
      onToken(buffer)
    }
  }
}

export function fetchQuestion(topic: string, searchMode: string, difficulty: string) {
  return post<{
    question: string
    options: string[]
    correct_index: number
    explanation: string
  }>('/api/question', { topic, search_mode: searchMode, difficulty })
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

export function fetchFollowupQuestion(
  topic: string,
  searchMode: string,
  previousQuestion: string,
  lessonSummary: string,
  wasCorrect: boolean,
  difficulty: string,
) {
  return post<{
    question: string
    options: string[]
    correct_index: number
    explanation: string
  }>('/api/followup', {
    topic,
    search_mode: searchMode,
    previous_question: previousQuestion,
    lesson_summary: lessonSummary,
    was_correct: wasCorrect,
    difficulty,
  })
}

export function fetchSummary(topic: string, lesson: string) {
  return post<{ takeaways: string[] }>('/api/summary', { topic, lesson })
}

export function fetchHint(question: string, options: string[]) {
  return post<{ hint: string }>('/api/hint', { question, options })
}

export function fetchRelated(topic: string) {
  return post<{ topics: string[] }>('/api/related', { topic })
}
