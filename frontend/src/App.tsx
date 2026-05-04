import { useState, useRef, useEffect, useCallback } from 'react'
import {
  fetchLesson, fetchQuestion, fetchEvaluation, fetchFollowupQuestion,
  fetchConfig, fetchSummary, fetchHint, fetchRelated,
} from './api'

type Phase =
  | 'selecting_mode'
  | 'selecting_difficulty'
  | 'idle'
  | 'teaching'
  | 'awaiting_test'
  | 'questioning'
  | 'awaiting_answer'
  | 'evaluating'
  | 'awaiting_retry'
  | 'followup_questioning'
  | 'awaiting_followup_answer'
  | 'followup_evaluating'
  | 'done'

type SearchMode = 'llm' | 'duckduckgo' | 'tavily'
type Difficulty = 'beginner' | 'intermediate' | 'advanced'

const MODE_LABELS: Record<SearchMode, string> = {
  llm: 'LLM',
  duckduckgo: 'DuckDuckGo',
  tavily: 'Tavily Search',
}

const DIFFICULTY_META: Record<Difficulty, { label: string; desc: string; icon: string }> = {
  beginner:     { label: 'Beginner',     desc: 'Simple language, no prior knowledge needed', icon: '🌱' },
  intermediate: { label: 'Intermediate', desc: 'Proper terminology, deeper concepts',         icon: '📚' },
  advanced:     { label: 'Advanced',     desc: 'Technical depth and nuanced coverage',        icon: '🔬' },
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
  takeaways?: string[]
  relatedTopics?: string[]
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
  const [difficulty, setDifficulty] = useState<Difficulty>('beginner')
  const [currentMcq, setCurrentMcq] = useState<MCQData | null>(null)
  const [lessonText, setLessonText] = useState('')
  const [tavilyAvailable, setTavilyAvailable] = useState(false)
  const [wasCorrect, setWasCorrect] = useState(true)
  const [hintUsed, setHintUsed] = useState(false)
  const [hintLoading, setHintLoading] = useState(false)
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
    push({ role: 'tutor', content: 'Great! Now choose your difficulty level:' })
    setPhase('selecting_difficulty')
  }

  const handleDifficultySelect = (d: Difficulty) => {
    setDifficulty(d)
    push({ role: 'user', content: DIFFICULTY_META[d].label })
    push({ role: 'tutor', content: 'What topic would you like to learn about today?' })
    setPhase('idle')
  }

  const startLesson = useCallback(async (t: string, currentDifficulty: Difficulty, currentMode: SearchMode) => {
    setCurrentMcq(null)
    setLessonText('')
    setHintUsed(false)
    setWasCorrect(true)
    setTopic(t)
    push({ role: 'user', content: t })
    push({ role: 'tutor', content: '', isLoading: true })
    setPhase('teaching')

    try {
      let lesson = ''
      await fetchLesson(
        t,
        currentMode,
        currentDifficulty,
        (statusMsg) => { patchLast({ content: statusMsg, isLoading: true }) },
        (token) => {
          lesson += token
          patchLast({ content: lesson, isLoading: false, isStreaming: true })
        },
      )
      setLessonText(lesson)
      patchLast({ isStreaming: false })

      try {
        const { takeaways } = await fetchSummary(t, lesson)
        if (takeaways?.length) {
          push({ role: 'tutor', content: 'Key takeaways from this lesson:', takeaways })
        }
      } catch {
        // silently skip if summary fails
      }

      setPhase('awaiting_test')
    } catch (err) {
      patchLast({
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isLoading: false,
        isStreaming: false,
      })
      setPhase('idle')
    }
  }, [push, patchLast])

  const handleTopicSubmit = async () => {
    const t = input.trim()
    if (!t) return
    setInput('')
    await startLesson(t, difficulty, searchMode)
  }

  const handleTestYes = async () => {
    setPhase('questioning')
    setHintUsed(false)
    push({ role: 'user', content: 'Test my knowledge' })
    push({ role: 'tutor', content: '', isLoading: true })

    try {
      const mcq = await fetchQuestion(topic, searchMode, difficulty)
      setCurrentMcq(mcq)
      patchLast({ content: mcq.question, mcq, isLoading: false })
      setPhase('awaiting_answer')
    } catch (err) {
      patchLast({ content: `Error: ${err instanceof Error ? err.message : String(err)}`, isLoading: false })
      setPhase('idle')
    }
  }

  const handleTestNo = () => {
    push({ role: 'user', content: 'Skip quiz' })
    push({ role: 'tutor', content: 'No problem! Would you like to explore another topic?' })
    setPhase('awaiting_retry')
  }

  const handleHint = async () => {
    if (!currentMcq || hintLoading) return
    setHintLoading(true)
    try {
      const { hint } = await fetchHint(currentMcq.question, currentMcq.options)
      push({ role: 'tutor', content: `Hint: ${hint}` })
      setHintUsed(true)
    } catch {
      push({ role: 'tutor', content: 'Sorry, I could not generate a hint right now.' })
    } finally {
      setHintLoading(false)
    }
  }

  const handleMcqSelect = async (selectedIndex: number) => {
    if (!currentMcq || phase !== 'awaiting_answer') return

    setMessages(prev => prev.map(m => (m.mcq ? { ...m, selectedOption: selectedIndex } : m)))
    push({ role: 'user', content: `Option ${selectedIndex + 1}: ${currentMcq.options[selectedIndex]}` })
    push({ role: 'tutor', content: '', isLoading: true })
    setPhase('evaluating')
    setWasCorrect(selectedIndex === currentMcq.correct_index)

    try {
      const { feedback } = await fetchEvaluation(selectedIndex, currentMcq.correct_index, currentMcq.explanation)
      patchLast({ content: feedback, isLoading: false })
      setPhase('awaiting_retry')
    } catch (err) {
      patchLast({ content: `Error: ${err instanceof Error ? err.message : String(err)}`, isLoading: false })
      setPhase('idle')
    }
  }

  const handleRetryYes = () => {
    setCurrentMcq(null)
    setLessonText('')
    setHintUsed(false)
    push({ role: 'user', content: 'Learn another topic' })
    push({ role: 'tutor', content: 'Great! What would you like to learn about next?' })
    setPhase('idle')
  }

  const handleRetryNo = async () => {
    push({ role: 'user', content: "I'm done" })
    push({ role: 'tutor', content: "Awesome session! Come back anytime you want to learn something new." })

    if (topic) {
      try {
        const { topics } = await fetchRelated(topic)
        if (topics?.length) {
          push({
            role: 'tutor',
            content: 'Here are some related topics you might enjoy next:',
            relatedTopics: topics,
          })
        }
      } catch {
        // silently skip
      }
    }

    setPhase('done')
  }

  const handleFollowup = async () => {
    setPhase('followup_questioning')
    setHintUsed(false)
    push({ role: 'user', content: 'Ask me a follow-up question' })
    push({ role: 'tutor', content: '', isLoading: true })

    try {
      const mcq = await fetchFollowupQuestion(
        topic, searchMode, currentMcq?.question ?? '', lessonText, wasCorrect, difficulty,
      )
      setCurrentMcq(mcq)
      patchLast({ content: mcq.question, mcq, isLoading: false })
      setPhase('awaiting_followup_answer')
    } catch (err) {
      patchLast({ content: `Error: ${err instanceof Error ? err.message : String(err)}`, isLoading: false })
      setPhase('awaiting_retry')
    }
  }

  const handleFollowupMcqSelect = async (selectedIndex: number) => {
    if (!currentMcq || phase !== 'awaiting_followup_answer') return

    setMessages(prev =>
      prev.map(m => (m.mcq && m.selectedOption === undefined ? { ...m, selectedOption: selectedIndex } : m)),
    )
    push({ role: 'user', content: `Option ${selectedIndex + 1}: ${currentMcq.options[selectedIndex]}` })
    push({ role: 'tutor', content: '', isLoading: true })
    setPhase('followup_evaluating')

    try {
      const { feedback } = await fetchEvaluation(selectedIndex, currentMcq.correct_index, currentMcq.explanation)
      patchLast({ content: feedback, isLoading: false })
      setPhase('awaiting_retry')
    } catch (err) {
      patchLast({ content: `Error: ${err instanceof Error ? err.message : String(err)}`, isLoading: false })
      setPhase('awaiting_retry')
    }
  }

  const handleStartOver = () => {
    setMessages([...INITIAL_MESSAGES])
    setPhase('selecting_mode')
    setTopic('')
    setCurrentMcq(null)
    setLessonText('')
    setSearchMode('llm')
    setDifficulty('beginner')
    setWasCorrect(true)
    setHintUsed(false)
    setInput('')
  }

  const isAwaitingAnswer = phase === 'awaiting_answer' || phase === 'awaiting_followup_answer'

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo-icon">E</div>
          <span className="header-title">EduSmart Tutor</span>
        </div>
        {phase !== 'selecting_mode' && phase !== 'selecting_difficulty' && (
          <div className="header-badges">
            <span className="header-badge">{MODE_LABELS[searchMode]}</span>
            <span className="header-badge">
              {DIFFICULTY_META[difficulty].icon} {DIFFICULTY_META[difficulty].label}
            </span>
          </div>
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
                    <div className="dots"><span /><span /><span /></div>
                    {msg.content && <span className="status-text">{msg.content}</span>}
                  </div>
                ) : (
                  <span className={`lesson-text${msg.isStreaming ? ' lesson-text--streaming' : ''}`}>
                    {msg.content}
                  </span>
                )}
              </div>

              {msg.takeaways && msg.takeaways.length > 0 && (
                <ul className="takeaways-list">
                  {msg.takeaways.map((t, i) => (
                    <li key={i} className="takeaway-item">{t}</li>
                  ))}
                </ul>
              )}

              {msg.relatedTopics && msg.relatedTopics.length > 0 && (
                <div className="related-row">
                  {msg.relatedTopics.map((t, i) => (
                    <button
                      key={i}
                      className="related-chip"
                      disabled={phase !== 'done'}
                      onClick={() => startLesson(t, difficulty, searchMode)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}

              {msg.mcq && !msg.isLoading && (
                <div className="mcq-list">
                  {msg.mcq.options.map((opt, i) => {
                    const answered = msg.selectedOption !== undefined
                    const isSelected = msg.selectedOption === i
                    const isCorrect = i === msg.mcq!.correct_index
                    const cls = ['mcq-btn',
                      answered && isCorrect ? 'correct' : '',
                      answered && isSelected && !isCorrect ? 'wrong' : '',
                    ].filter(Boolean).join(' ')
                    return (
                      <button
                        key={i}
                        className={cls}
                        disabled={answered || !isAwaitingAnswer}
                        onClick={() =>
                          phase === 'awaiting_followup_answer'
                            ? handleFollowupMcqSelect(i)
                            : handleMcqSelect(i)
                        }
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
                <span className="mode-name">LLM</span>
                <span className="mode-desc">Uses AI knowledge only</span>
              </span>
            </button>
            <button className="btn mode-btn" onClick={() => handleModeSelect('duckduckgo')}>
              <span className="mode-icon">🦆</span>
              <span className="mode-info">
                <span className="mode-name">DuckDuckGo</span>
                <span className="mode-desc">Live web search</span>
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

        {phase === 'selecting_difficulty' && (
          <div className="mode-row">
            {(Object.keys(DIFFICULTY_META) as Difficulty[]).map(d => (
              <button key={d} className="btn mode-btn" onClick={() => handleDifficultySelect(d)}>
                <span className="mode-icon">{DIFFICULTY_META[d].icon}</span>
                <span className="mode-info">
                  <span className="mode-name">{DIFFICULTY_META[d].label}</span>
                  <span className="mode-desc">{DIFFICULTY_META[d].desc}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {phase === 'awaiting_test' && (
          <div className="action-row">
            <button className="btn primary" onClick={handleTestYes}>Test my knowledge</button>
            <button className="btn ghost" onClick={handleTestNo}>Skip quiz</button>
          </div>
        )}

        {isAwaitingAnswer && !hintUsed && (
          <div className="action-row">
            <button className="btn hint-btn" onClick={handleHint} disabled={hintLoading}>
              {hintLoading ? 'Getting hint…' : '💡 Get a hint'}
            </button>
          </div>
        )}

        {phase === 'awaiting_retry' && (
          <div className="action-row">
            <button className="btn primary" onClick={handleRetryYes}>Learn another topic</button>
            <button className="btn secondary" onClick={handleFollowup}>Ask a follow-up</button>
            <button className="btn ghost" onClick={handleRetryNo}>I'm done</button>
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
            <button className="btn primary" onClick={handleTopicSubmit} disabled={!input.trim()}>
              Send
            </button>
          </div>
        )}

        {phase === 'done' && (
          <div className="action-row">
            <button className="btn primary" onClick={handleStartOver}>Start over</button>
          </div>
        )}
      </footer>
    </div>
  )
}
