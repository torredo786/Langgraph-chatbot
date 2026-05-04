import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

_ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def _reload_env() -> None:
    load_dotenv(_ENV_PATH, override=True)


_reload_env()

from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import (  # noqa: F401
    build_followup_question_prompt,
    build_graph,
    build_hint_prompt,
    build_related_topics_prompt,
    build_summary_prompt,
    get_llm,
    get_search_context,
    stream_lesson,
)

api_key = os.getenv("OPENROUTER_API_KEY", "")
model_name = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")

if not api_key:
    raise RuntimeError("OPENROUTER_API_KEY not set in .env")

llm = get_llm(api_key, model_name)
graph = build_graph(llm)

app = FastAPI(title="EduSmart Tutor API")

_raw_origins = os.getenv("ALLOWED_ORIGINS", "")
_allowed_origins = (
    [o.strip() for o in _raw_origins.split(",") if o.strip()]
    if _raw_origins
    else ["http://localhost:5173", "http://127.0.0.1:5173"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _get_tavily_key() -> str:
    _reload_env()
    return os.getenv("TAVILY_API_KEY", "")


class TopicRequest(BaseModel):
    topic: str
    search_mode: str = "llm"
    difficulty: str = "beginner"


class EvaluateRequest(BaseModel):
    selected_index: int
    correct_index: int
    explanation: str


class FollowupRequest(BaseModel):
    topic: str
    search_mode: str = "llm"
    previous_question: str = ""
    lesson_summary: str = ""
    difficulty: str = "beginner"
    was_correct: bool = True


class SummaryRequest(BaseModel):
    topic: str
    lesson: str


class HintRequest(BaseModel):
    question: str
    options: List[str]


class RelatedRequest(BaseModel):
    topic: str


@app.get("/health")
def health():
    return {"status": "ok", "model": model_name}


@app.get("/api/config")
def config():
    return {"tavily_available": bool(_get_tavily_key())}


@app.post("/api/teach")
async def teach(req: TopicRequest):
    tavily_key = _get_tavily_key()

    async def generate():
        try:
            async for token in stream_lesson(llm, req.topic, req.search_mode, tavily_key, req.difficulty):
                yield token
        except Exception as e:
            yield f"__STATUS__:Error\n[Error: {e}]"

    return StreamingResponse(
        generate(),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/question")
async def question(req: TopicRequest):
    try:
        tavily_key = _get_tavily_key()
        context = await get_search_context(req.topic, req.search_mode, tavily_key)
        result = await asyncio.to_thread(
            graph.invoke,
            {
                "next_step": "question",
                "topic": req.topic,
                "search_context": context,
                "difficulty": req.difficulty,
            },
        )
        return {
            "question": result["question"],
            "options": result["options"],
            "correct_index": result["correct_index"],
            "explanation": result["explanation"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/followup")
async def followup(req: FollowupRequest):
    try:
        tavily_key = _get_tavily_key()
        context = await get_search_context(req.topic, req.search_mode, tavily_key)
        prompt = build_followup_question_prompt(
            req.topic,
            context,
            req.previous_question,
            req.lesson_summary,
            req.difficulty,
            req.was_correct,
        )

        def _invoke():
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
            return parsed

        parsed = await asyncio.to_thread(_invoke)
        return {
            "question": parsed["question"],
            "options": parsed["options"],
            "correct_index": parsed["correct_index"],
            "explanation": parsed["explanation"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/evaluate")
async def evaluate(req: EvaluateRequest):
    try:
        result = await asyncio.to_thread(
            graph.invoke,
            {
                "next_step": "evaluate",
                "selected_index": req.selected_index,
                "correct_index": req.correct_index,
                "explanation": req.explanation,
            },
        )
        return {"feedback": result["feedback"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/summary")
async def summary(req: SummaryRequest):
    try:
        prompt = build_summary_prompt(req.topic, req.lesson)

        def _invoke():
            response = llm.invoke(prompt)
            raw = response.content.strip()
            cleaned = raw.replace("```json", "").replace("```", "").strip()
            return json.loads(cleaned)

        takeaways = await asyncio.to_thread(_invoke)
        if not isinstance(takeaways, list):
            raise ValueError("Expected a JSON array")
        return {"takeaways": [str(t) for t in takeaways[:5]]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/hint")
async def hint(req: HintRequest):
    try:
        prompt = build_hint_prompt(req.question, req.options)

        def _invoke():
            return llm.invoke(prompt).content.strip()

        hint_text = await asyncio.to_thread(_invoke)
        return {"hint": hint_text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/related")
async def related(req: RelatedRequest):
    try:
        prompt = build_related_topics_prompt(req.topic)

        def _invoke():
            response = llm.invoke(prompt)
            raw = response.content.strip()
            cleaned = raw.replace("```json", "").replace("```", "").strip()
            return json.loads(cleaned)

        topics = await asyncio.to_thread(_invoke)
        if not isinstance(topics, list):
            raise ValueError("Expected a JSON array")
        return {"topics": [str(t) for t in topics[:5]]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
