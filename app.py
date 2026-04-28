import asyncio
import json
from typing import AsyncIterator, List, TypedDict

from ddgs import DDGS
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from tavily import AsyncTavilyClient, TavilyClient


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


# ── Synchronous DuckDuckGo (run via asyncio.to_thread) ────────────────────────

def _ddg_search(topic: str) -> str:
    with DDGS() as d:
        results = d.text(f"{topic} explained guide", max_results=8)
    snippets = [f"Article {i+1} - {r['title']}:\n{r['body'][:600]}" for i, r in enumerate(results)]
    return "\n\n".join(snippets)


# ── Async search context fetcher ──────────────────────────────────────────────

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


# ── Prompt builders ───────────────────────────────────────────────────────────

def build_teach_prompt(topic: str, context: str) -> str:
    if context:
        return (
            "You are an expert tutor. Based on the following search results from multiple articles, "
            "write a comprehensive 3-paragraph explanation of the topic for a beginner.\n"
            "- Paragraph 1: Introduce the topic and explain what it is.\n"
            "- Paragraph 2: Explain how it works or its key concepts with examples.\n"
            "- Paragraph 3: Describe real-world applications or why it matters.\n"
            "Synthesize the information from ALL articles. Be clear and engaging.\n\n"
            f"Topic: {topic}\n\n"
            f"Search Results:\n{context}"
        )
    return (
        "You are an expert tutor. Write a comprehensive 3-paragraph explanation of the topic for a beginner.\n"
        "- Paragraph 1: Introduce the topic and explain what it is.\n"
        "- Paragraph 2: Explain how it works or its key concepts with examples.\n"
        "- Paragraph 3: Describe real-world applications or why it matters.\n"
        "Be clear and engaging.\n\n"
        f"Topic: {topic}"
    )


def build_question_prompt(topic: str, context: str) -> str:
    context_section = f"\n\nSearch Results for context:\n{context}" if context else ""
    return (
        "Create exactly one multiple-choice question about this topic.\n"
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


# ── Streaming lesson generator ────────────────────────────────────────────────

async def stream_lesson(
    llm: ChatOpenAI,
    topic: str,
    mode: str,
    tavily_api_key: str,
) -> AsyncIterator[str]:
    # Immediately signal the browser that the response has started.
    # For search modes, label what's happening so the client can show it.
    if mode == "duckduckgo":
        yield "__STATUS__:Searching DuckDuckGo...\n"
    elif mode == "tavily":
        yield "__STATUS__:Searching Tavily...\n"

    context = await get_search_context(topic, mode, tavily_api_key)

    if context and mode != "llm":
        yield "__STATUS__:Summarizing results...\n"

    prompt = build_teach_prompt(topic, context)
    async for chunk in llm.astream(prompt):
        if chunk.content:
            yield chunk.content


# ── LangGraph (question + evaluate) ──────────────────────────────────────────

def build_graph(llm: ChatOpenAI):
    def router(state: LearningState) -> LearningState:
        return state

    def question_node(state: LearningState) -> LearningState:
        topic = state.get("topic", "")
        context = state.get("search_context", "")
        prompt = build_question_prompt(topic, context)
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
