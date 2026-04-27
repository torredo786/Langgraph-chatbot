import { useState, useRef, useEffect, useCallback } from 'react'
import { fetchLesson, fetchQuestion, fetchEvaluation } from './api'

type Phase =
  | 'idle'
  | 'teaching'
  | 'awaiting_test'
  | 'questioning'
  | 'awaiting_answer'
  | 'evaluating'
  | 'awaiting_retry'
  | 'done'

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
  mcq?: MCQData
  selectedOption?: number
}

let _id = 0
const uid = () => String(++_id)

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: 'tutor',
      content: "Hi! I'm your AI tutor. What topic would you like to learn about today?",
    },
  ])
  const [phase, setPhase] = useState<Phase>('idle')
  const [input, setInput] = useState('')
  const [topic, setTopic] = useState('')
  const [currentMcq, setCurrentMcq] = useState<MCQData | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

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

  const handleTopicSubmit = async () => {
    const t = input.trim()
    if (!t) return
    setInput('')
    setTopic(t)
    push({ role: 'user', content: t })
    push({ role: 'tutor', content: '', isLoading: true })
    setPhase('teaching')

    try {
      const { lesson } = await fetchLesson(t)
      patchLast({ content: lesson, isLoading: false })
      setPhase('awaiting_test')
    } catch (err) {
      patchLast({
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isLoading: false,
      })
      setPhase('idle')
    }
  }

  const handleTestYes = async () => {
    setPhase('questioning')
    push({ role: 'user', content: 'Test my knowledge' })
    push({ role: 'tutor', content: '', isLoading: true })

    try {
      const mcq = await fetchQuestion(topic)
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

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo-icon">E</div>
          <span className="header-title">EduSmart Tutor</span>
        </div>
        <span className="header-badge">OpenRouter</span>
      </header>

      <main className="messages">
        {messages.map(msg => (
          <div key={msg.id} className={`row ${msg.role}`}>
            <div className="avatar">{msg.role === 'tutor' ? 'AI' : 'You'}</div>
            <div className="msg-body">
              <div className="bubble">
                {msg.isLoading ? (
                  <div className="dots">
                    <span /><span /><span />
                  </div>
                ) : (
                  <span>{msg.content}</span>
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
            <button
              className="btn primary"
              onClick={() => {
                setMessages([
                  {
                    id: uid(),
                    role: 'tutor',
                    content: "Welcome back! What topic would you like to learn about?",
                  },
                ])
                setPhase('idle')
                setTopic('')
                setCurrentMcq(null)
              }}
            >
              Start over
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
