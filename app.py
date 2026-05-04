import asyncio
import json
from typing import AsyncIterator, List, TypedDict

from ddgs import DDGS
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from tavily import AsyncTavilyClient


class LearningState(TypedDict, total=False):
    next_step: str
    topic: str
    lesson: str
    question: str
    options: List[str]
    correct_index: int
    explanation: str
    selected_index: int
    feedback: str
    search_mode: str
    search_context: str
    difficulty: str


def _ddg_search(topic: str) -> str:
    with DDGS() as d:
        results = d.text(f"{topic} explained guide", max_results=5)
    snippets = [f"Article {i+1} - {r['title']}:\n{r['body'][:600]}" for i, r in enumerate(results)]
    return "\n\n".join(snippets)


async def get_search_context(
    topic: str,
    mode: str,
    tavily_api_key: str,
    timeout: float = 10.0,
) -> str:
    if mode == "duckduckgo":
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_ddg_search, topic),
                timeout=timeout,
            )
        except Exception:
            return ""

    if mode == "tavily":
        if not tavily_api_key:
            raise ValueError("TAVILY_API_KEY is not configured. Add it to your .env file.")
        try:
            client = AsyncTavilyClient(api_key=tavily_api_key)
            response = await asyncio.wait_for(
                client.search(topic, max_results=5),
                timeout=timeout,
            )
            snippets = [
                f"Article {i+1} - {r['title']}:\n{r.get('content', '')[:600]}"
                for i, r in enumerate(response.get("results", []))
            ]
            return "\n\n".join(snippets)
        except Exception:
            return ""

    return ""


_DIFFICULTY_LESSON = {
    "beginner": "Write for a complete beginner with no prior knowledge. Use simple language and relatable analogies.",
    "intermediate": "Write for someone with basic familiarity. Use proper terminology and go deeper into mechanisms.",
    "advanced": "Write for an experienced learner. Include technical depth, nuances, and edge cases.",
}

_DIFFICULTY_QUESTION = {
    "beginner": "Make the question straightforward — test recall of basic facts.",
    "intermediate": "Make the question moderately challenging — test conceptual understanding and reasoning.",
    "advanced": "Make the question challenging — test deep understanding, application, or subtle distinctions.",
}


def build_teach_prompt(topic: str, context: str, difficulty: str = "beginner") -> str:
    rules = (
        "Write in plain prose only. "
        "Do NOT use markdown: no #, ##, **, *, -, or any other markdown symbols. "
        "Separate each paragraph with a blank line. "
        "No headers, no bullet points, no bold or italic text."
    )
    level = _DIFFICULTY_LESSON.get(difficulty, _DIFFICULTY_LESSON["beginner"])
    if context:
        return (
            f"You are an expert tutor. {rules}\n\n"
            f"{level}\n\n"
            "Based on the following search results, write a comprehensive 3-paragraph explanation.\n"
            "Paragraph 1: Introduce the topic and explain what it is.\n"
            "Paragraph 2: Explain how it works or its key concepts with examples.\n"
            "Paragraph 3: Describe real-world applications or why it matters.\n"
            "Synthesize information from ALL articles. Be clear and engaging.\n\n"
            f"Topic: {topic}\n\nSearch Results:\n{context}"
        )
    return (
        f"You are an expert tutor. {rules}\n\n"
        f"{level}\n\n"
        "Write a comprehensive 3-paragraph explanation of the topic.\n"
        "Paragraph 1: Introduce the topic and explain what it is.\n"
        "Paragraph 2: Explain how it works or its key concepts with examples.\n"
        "Paragraph 3: Describe real-world applications or why it matters.\n"
        "Be clear and engaging.\n\n"
        f"Topic: {topic}"
    )


def build_question_prompt(topic: str, context: str, difficulty: str = "beginner") -> str:
    context_section = f"\n\nSearch Results for context:\n{context}" if context else ""
    level = _DIFFICULTY_QUESTION.get(difficulty, _DIFFICULTY_QUESTION["beginner"])
    return (
        "Create exactly one multiple-choice question about this topic.\n"
        f"{level}\n"
        "Return ONLY valid JSON with this schema:\n"
        '{\n'
        '  "question": "string",\n'
        '  "options": ["option A", "option B", "option C", "option D"],\n'
        '  "correct_index": 0,\n'
        '  "explanation": "short explanation of why the answer is correct"\n'
        "}\n"
        "Rules: options must be exactly 4 items, correct_index must be 0-3.\n\n"
        f"Topic: {topic}{context_section}"
    )


def build_followup_question_prompt(
    topic: str,
    context: str,
    previous_question: str,
    lesson_summary: str,
    difficulty: str = "beginner",
    was_correct: bool = True,
) -> str:
    context_section = f"\n\nSearch Results for context:\n{context}" if context else ""
    prev_section = f"\n\nPrevious question already asked (do NOT repeat it):\n{previous_question}" if previous_question else ""
    lesson_section = f"\n\nLesson already taught to the student:\n{lesson_summary[:1000]}" if lesson_summary else ""
    level = _DIFFICULTY_QUESTION.get(difficulty, _DIFFICULTY_QUESTION["beginner"])
    adapt = (
        "The student answered the previous question CORRECTLY — make this one slightly more challenging."
        if was_correct
        else "The student answered the previous question INCORRECTLY — make this one simpler to reinforce the basics."
    )
    return (
        "The student just read a lesson and answered one quiz question about this topic. "
        "Now create a NEW follow-up multiple-choice question that:\n"
        "- Tests a DIFFERENT aspect or concept than the previous question\n"
        "- Checks whether the student retained what was taught in the lesson\n"
        f"- {adapt}\n"
        f"- {level}\n"
        "Return ONLY valid JSON with this schema:\n"
        '{\n'
        '  "question": "string",\n'
        '  "options": ["option A", "option B", "option C", "option D"],\n'
        '  "correct_index": 0,\n'
        '  "explanation": "short explanation of why the answer is correct"\n'
        "}\n"
        "Rules: options must be exactly 4 items, correct_index must be 0-3.\n\n"
        f"Topic: {topic}{lesson_section}{prev_section}{context_section}"
    )


def build_summary_prompt(topic: str, lesson: str) -> str:
    return (
        f"Based on the following lesson about '{topic}', extract exactly 4 key takeaways.\n"
        "Return ONLY a JSON array of 4 concise strings, each under 15 words.\n"
        'Example: ["First key point", "Second key point", "Third key point", "Fourth key point"]\n\n'
        f"Lesson:\n{lesson[:2000]}"
    )


def build_hint_prompt(question: str, options: List[str]) -> str:
    options_text = "\n".join(f"{chr(65 + i)}. {opt}" for i, opt in enumerate(options))
    return (
        f"A student is trying to answer this multiple-choice question:\n\n"
        f"Question: {question}\n\nOptions:\n{options_text}\n\n"
        "Give a short hint (1-2 sentences) that guides the student toward the correct answer "
        "WITHOUT directly revealing it. Help them think about the right concept or eliminate wrong answers."
    )


def build_related_topics_prompt(topic: str) -> str:
    return (
        f"A student just finished learning about '{topic}'.\n"
        "Suggest exactly 5 related topics they could explore next.\n"
        "Return ONLY a JSON array of 5 short topic strings (2-5 words each).\n"
        'Example: ["Topic one", "Topic two", "Topic three", "Topic four", "Topic five"]'
    )


async def stream_lesson(
    llm: ChatOpenAI,
    topic: str,
    mode: str,
    tavily_api_key: str,
    difficulty: str = "beginner",
) -> AsyncIterator[str]:
    if mode == "duckduckgo":
        yield "__STATUS__:Searching DuckDuckGo...\n"
    elif mode == "tavily":
        yield "__STATUS__:Searching Tavily...\n"

    context = await get_search_context(topic, mode, tavily_api_key)

    if context and mode != "llm":
        yield "__STATUS__:Summarizing results...\n"

    prompt = build_teach_prompt(topic, context, difficulty)
    async for chunk in llm.astream(prompt):
        if chunk.content:
            yield chunk.content


def build_graph(llm: ChatOpenAI):
    def router(state: LearningState) -> LearningState:
        return state

    def question_node(state: LearningState) -> LearningState:
        topic = state.get("topic", "")
        context = state.get("search_context", "")
        difficulty = state.get("difficulty", "beginner")
        prompt = build_question_prompt(topic, context, difficulty)
        response = llm.invoke(prompt)
        raw = response.content.strip()
        cleaned = raw.replace("```json", "").replace("```", "").strip()
        parsed = json.loads(cleaned)

        options = parsed.get("options", [])
        if len(options) != 4:
            raise ValueError("Model did not return exactly 4 options.")

        correct_index = int(parsed.get("correct_index", -1))
        if correct_index not in [0, 1, 2, 3]:
            raise ValueError("Model returned an invalid correct_index.")

        return {
            "question": parsed["question"],
            "options": options,
            "correct_index": correct_index,
            "explanation": parsed["explanation"],
        }

    def evaluate_node(state: LearningState) -> LearningState:
        selected_index = int(state.get("selected_index", -1))
        correct_index = int(state.get("correct_index", -1))
        explanation = state.get("explanation", "")

        if selected_index == correct_index:
            feedback = f"Correct! Nice work. {explanation}"
        else:
            feedback = (
                f"Not quite. The correct answer was option {correct_index + 1}. "
                f"{explanation}"
            )
        return {"feedback": feedback}

    def route_decision(state: LearningState) -> str:
        return state.get("next_step", "question")

    graph_builder = StateGraph(LearningState)
    graph_builder.add_node("router", router)
    graph_builder.add_node("question", question_node)
    graph_builder.add_node("evaluate", evaluate_node)

    graph_builder.add_edge(START, "router")
    graph_builder.add_conditional_edges(
        "router",
        route_decision,
        {"question": "question", "evaluate": "evaluate"},
    )
    graph_builder.add_edge("question", END)
    graph_builder.add_edge("evaluate", END)
    return graph_builder.compile()


def get_llm(api_key: str, model_name: str) -> ChatOpenAI:
    return ChatOpenAI(
        model=model_name,
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",
        temperature=0.4,
        max_tokens=1024,
    )
