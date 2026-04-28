import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

_ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def _reload_env() -> None:
    load_dotenv(_ENV_PATH, override=True)


_reload_env()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import build_graph, get_llm, get_search_context, stream_lesson  # noqa: F401

api_key = os.getenv("OPENROUTER_API_KEY", "")
model_name = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v3.2")

if not api_key:
    raise RuntimeError("OPENROUTER_API_KEY not set in .env")

llm = get_llm(api_key, model_name)
graph = build_graph(llm)

app = FastAPI(title="EduSmart Tutor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _get_tavily_key() -> str:
    _reload_env()
    return os.getenv("TAVILY_API_KEY", "")


class TopicRequest(BaseModel):
    topic: str
    search_mode: str = "llm"


class EvaluateRequest(BaseModel):
    selected_index: int
    correct_index: int
    explanation: str


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
            async for token in stream_lesson(llm, req.topic, req.search_mode, tavily_key):
                print(token)
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
            {"next_step": "question", "topic": req.topic, "search_context": context},
        )
        return {
            "question": result["question"],
            "options": result["options"],
            "correct_index": result["correct_index"],
            "explanation": result["explanation"],
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
