import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import build_graph, get_llm

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


class TopicRequest(BaseModel):
    topic: str


class EvaluateRequest(BaseModel):
    selected_index: int
    correct_index: int
    explanation: str


@app.get("/health")
def health():
    return {"status": "ok", "model": model_name}


@app.post("/api/teach")
def teach(req: TopicRequest):
    try:
        result = graph.invoke({"next_step": "teach", "topic": req.topic})
        return {"lesson": result["lesson"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/question")
def question(req: TopicRequest):
    try:
        result = graph.invoke({"next_step": "question", "topic": req.topic})
        return {
            "question": result["question"],
            "options": result["options"],
            "correct_index": result["correct_index"],
            "explanation": result["explanation"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/evaluate")
def evaluate(req: EvaluateRequest):
    try:
        result = graph.invoke({
            "next_step": "evaluate",
            "selected_index": req.selected_index,
            "correct_index": req.correct_index,
            "explanation": req.explanation,
        })
        return {"feedback": result["feedback"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
