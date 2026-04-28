import { useState, useRef, useEffect, useCallback } from 'react'
import { fetchLesson, fetchQuestion, fetchEvaluation, fetchConfig } from './api'

type Phase =
  | 'selecting_mode'
  | 'idle'
  | 'teaching'
  | 'awaiting_test'
  | 'questioning'
  | 'awaiting_answer'
  | 'evaluating'
  | 'awaiting_retry'
  | 'done'

type SearchMode = 'llm' | 'duckduckgo' | 'tavily'

const MODE_LABELS: Record<SearchMode, string> = {
  llm: 'Direct LLM',
  duckduckgo: 'DuckDuckGo',
  tavily: 'Tavily Search',
}

type MCQData = {
  question: string
  options: string[]
  correct_index: number
  explanation: string
}

type Message = {
  id: string
  role: 'tutor' | 'user'
  content: string
  isLoading?: boolean
  isStreaming?: boolean
  mcq?: MCQData
  selectedOption?: number
}

let _id = 0
const uid = () => String(++_id)

const INITIAL_MESSAGES: Message[] = [
  {
    id: uid(),
    role: 'tutor',
    content: "Hi! I'm your AI tutor. Before we start, choose how you'd like me to look up information:",
  },
]

export default function App() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES)
  const [phase, setPhase] = useState<Phase>('selecting_mode')
  const [input, setInput] = useState('')
  const [topic, setTopic] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('llm')
  const [currentMcq, setCurrentMcq] = useState<MCQData | null>(null)
  const [tavilyAvailable, setTavilyAvailable] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (phase === 'selecting_mode') {
      fetchConfig().then(c => setTavilyAvailable(c.tavily_available))
    }
  }, [phase])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const push = useCallback((msg: Omit<Message, 'id'>) => {
    setMessages(prev => [...prev, { id: uid(), ...msg }])
  }, [])

  const patchLast = useCallback((patch: Partial<Message>) => {
    setMessages(prev =>
      prev.map((m, i) => (i === prev.length - 1 ? { ...m, ...patch } : m)),
    )
  }, [])

  const handleModeSelect = (mode: SearchMode) => {
    setSearchMode(mode)
    push({ role: 'user', content: MODE_LABELS[mode] })
    push({ role: 'tutor', content: 'Great choice! What topic would you like to learn about today?' })
    setPhase('idle')
  }

  const handleTopicSubmit = async () => {
    const t = input.trim()
    if (!t) return
    setInput('')
    setTopic(t)
    push({ role: 'user', content: t })
    push({ role: 'tutor', content: '', isLoading: true })
    setPhase('teaching')

    try {
      let lesson = ''
      await fetchLesson(
        t,
        searchMode,
        (statusMsg) => {
          patchLast({ content: statusMsg, isLoading: true })
        },
        (token) => {
          lesson += token
          patchLast({ content: lesson, isLoading: false, isStreaming: true })
        },
      )
      patchLast({ isStreaming: false })
      setPhase('awaiting_test')
    } catch (err) {
      patchLast({
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isLoading: false,
        isStreaming: false,
      })
      setPhase('idle')
    }
  }

  const handleTestYes = async () => {
    setPhase('questioning')
    push({ role: 'user', content: 'Test my knowledge' })
    push({ role: 'tutor', content: '', isLoading: true })

    try {
      const mcq = await fetchQuestion(topic, searchMode)
      setCurrentMcq(mcq)
      patchLast({ content: mcq.question, mcq, isLoading: false })
      setPhase('awaiting_answer')
    } catch (err) {
      patchLast({
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isLoading: false,
      })
      setPhase('idle')
    }
  }

  const handleTestNo = () => {
    push({ role: 'user', content: 'Skip quiz' })
    push({ role: 'tutor', content: 'No problem! Would you like to explore another topic?' })
    setPhase('awaiting_retry')
  }

  const handleMcqSelect = async (selectedIndex: number) => {
    if (!currentMcq || phase !== 'awaiting_answer') return

    setMessages(prev =>
      prev.map(m => (m.mcq ? { ...m, selectedOption: selectedIndex } : m)),
    )
    push({ role: 'user', content: `Option ${selectedIndex + 1}: ${currentMcq.options[selectedIndex]}` })
    push({ role: 'tutor', content: '', isLoading: true })
    setPhase('evaluating')

    try {
      const { feedback } = await fetchEvaluation(
        selectedIndex,
        currentMcq.correct_index,
        currentMcq.explanation,
      )
      patchLast({ content: feedback, isLoading: false })
      setPhase('awaiting_retry')
    } catch (err) {
      patchLast({
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isLoading: false,
      })
      setPhase('idle')
    }
  }

  const handleRetryYes = () => {
    setTopic('')
    setCurrentMcq(null)
    push({ role: 'user', content: 'Learn another topic' })
    push({ role: 'tutor', content: 'Great! What would you like to learn about next?' })
    setPhase('idle')
  }

  const handleRetryNo = () => {
    push({ role: 'user', content: "I'm done" })
    push({
      role: 'tutor',
      content: "Awesome session! Come back anytime you want to learn something new. Goodbye!",
    })
    setPhase('done')
  }

  const handleStartOver = () => {
    setMessages([...INITIAL_MESSAGES])
    setPhase('selecting_mode')
    setTopic('')
    setCurrentMcq(null)
    setSearchMode('llm')
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo-icon">E</div>
          <span className="header-title">EduSmart Tutor</span>
        </div>
        {phase !== 'selecting_mode' && (
          <span className="header-badge">{MODE_LABELS[searchMode]}</span>
        )}
      </header>

      <main className="messages">
        {messages.map(msg => (
          <div key={msg.id} className={`row ${msg.role}`}>
            <div className="avatar">{msg.role === 'tutor' ? 'AI' : 'You'}</div>
            <div className="msg-body">
              <div className="bubble">
                {msg.isLoading ? (
                  <div className="loading-state">
                    <div className="dots">
                      <span /><span /><span />
                    </div>
                    {msg.content && (
                      <span className="status-text">{msg.content}</span>
                    )}
                  </div>
                ) : (
                  <span className={`lesson-text${msg.isStreaming ? ' lesson-text--streaming' : ''}`}>
                    {msg.content}
                  </span>
                )}
              </div>

              {msg.mcq && !msg.isLoading && (
                <div className="mcq-list">
                  {msg.mcq.options.map((opt, i) => {
                    const answered = msg.selectedOption !== undefined
                    const isSelected = msg.selectedOption === i
                    const isCorrect = i === msg.mcq!.correct_index
                    const cls = [
                      'mcq-btn',
                      answered && isCorrect ? 'correct' : '',
                      answered && isSelected && !isCorrect ? 'wrong' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                    return (
                      <button
                        key={i}
                        className={cls}
                        disabled={answered || phase !== 'awaiting_answer'}
                        onClick={() => handleMcqSelect(i)}
                      >
                        <span className="opt-key">{String.fromCharCode(65 + i)}</span>
                        {opt}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </main>

      <footer className="footer">
        {phase === 'selecting_mode' && (
          <div className="mode-row">
            <button className="btn mode-btn" onClick={() => handleModeSelect('llm')}>
              <span className="mode-icon">🤖</span>
              <span className="mode-info">
                <span className="mode-name">Direct LLM</span>
                <span className="mode-desc">Uses AI knowledge only</span>
              </span>
            </button>
            <button className="btn mode-btn" onClick={() => handleModeSelect('duckduckgo')}>
              <span className="mode-icon">🦆</span>
              <span className="mode-info">
                <span className="mode-name">DuckDuckGo</span>
                <span className="mode-desc">Searches the web (no API key)</span>
              </span>
            </button>
            <button
              className={`btn mode-btn${!tavilyAvailable ? ' mode-btn--disabled' : ''}`}
              onClick={() => tavilyAvailable && handleModeSelect('tavily')}
              disabled={!tavilyAvailable}
              title={!tavilyAvailable ? 'Add TAVILY_API_KEY to .env to enable' : undefined}
            >
              <span className="mode-icon">🔍</span>
              <span className="mode-info">
                <span className="mode-name">Tavily Search</span>
                <span className="mode-desc">
                  {tavilyAvailable ? 'AI-optimized web search' : 'API key not configured'}
                </span>
              </span>
            </button>
          </div>
        )}

        {phase === 'awaiting_test' && (
          <div className="action-row">
            <button className="btn primary" onClick={handleTestYes}>
              Test my knowledge
            </button>
            <button className="btn ghost" onClick={handleTestNo}>
              Skip quiz
            </button>
          </div>
        )}

        {phase === 'awaiting_retry' && (
          <div className="action-row">
            <button className="btn primary" onClick={handleRetryYes}>
              Learn another topic
            </button>
            <button className="btn ghost" onClick={handleRetryNo}>
              I'm done
            </button>
          </div>
        )}

        {phase === 'idle' && (
          <div className="input-row">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleTopicSubmit()}
              placeholder="Type a topic to learn about…"
              autoFocus
            />
            <button
              className="btn primary"
              onClick={handleTopicSubmit}
              disabled={!input.trim()}
            >
              Send
            </button>
          </div>
        )}

        {phase === 'done' && (
          <div className="action-row">
            <button className="btn primary" onClick={handleStartOver}>
              Start over
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
