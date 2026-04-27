import json
from typing import List, TypedDict

from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph


class LearningState(TypedDict, total=False):
    # Shared state keys passed between graph nodes.
    next_step: str
    topic: str
    lesson: str
    question: str
    options: List[str]
    correct_index: int
    explanation: str
    selected_index: int
    feedback: str


def build_graph(llm: ChatOpenAI):
    def router(state: LearningState) -> LearningState:
        # Router node only forwards state; branching is decided by route_decision().
        return state

    def teach_node(state: LearningState) -> LearningState:
        topic = state.get("topic", "")
        prompt = (
            "You are a friendly tutor. Teach this topic in one short paragraph "
            "(3-4 sentences), clear and beginner-friendly.\n\n"
            f"Topic: {topic}"
        )
        response = llm.invoke(prompt)
        return {"lesson": response.content.strip()}

    def question_node(state: LearningState) -> LearningState:
        topic = state.get("topic", "")
        prompt = (
            "Create exactly one multiple-choice question about this topic.\n"
            "Return ONLY valid JSON with this schema:\n"
            '{\n'
            '  "question": "string",\n'
            '  "options": ["option A", "option B", "option C", "option D"],\n'
            '  "correct_index": 0,\n'
            '  "explanation": "short explanation of why the answer is correct"\n'
            "}\n"
            "Rules: options must be exactly 4 items, correct_index must be 0-3.\n\n"
            f"Topic: {topic}"
        )
        response = llm.invoke(prompt)
        raw = response.content.strip()
        # Some models wrap JSON in markdown fences; strip them before parsing.
        cleaned = raw.replace("```json", "").replace("```", "").strip()
        parsed = json.loads(cleaned)

        options = parsed.get("options", [])
        # Guardrails keep output shape predictable if model output drifts.
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
        # Branch target is provided by caller via state["next_step"].
        return state.get("next_step", "teach")

    graph_builder = StateGraph(LearningState)
    graph_builder.add_node("router", router)
    graph_builder.add_node("teach", teach_node)
    graph_builder.add_node("question", question_node)
    graph_builder.add_node("evaluate", evaluate_node)

    graph_builder.add_edge(START, "router")
    graph_builder.add_conditional_edges(
        "router",
        route_decision,
        {"teach": "teach", "question": "question", "evaluate": "evaluate"},
    )
    graph_builder.add_edge("teach", END)
    graph_builder.add_edge("question", END)
    graph_builder.add_edge("evaluate", END)
    return graph_builder.compile()


def get_llm(api_key: str, model_name: str) -> ChatOpenAI:
    return ChatOpenAI(
        model=model_name,
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",
        temperature=0.4,
    )
