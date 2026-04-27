# LangGraph Learning Tutor (Gemini, Terminal)

A terminal-based Python learning app that:

1. Asks the user for a topic
2. Teaches the concept with a short explanation
3. Prompts a **Test Knowledge** step in terminal
4. Presents one multiple-choice question
5. Evaluates the selected answer and gives feedback
6. Prompts a **Try Another Area** step to restart

## Setup

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Create a `.env` file in the project root:

```env
GOOGLE_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.0-flash
```

`gemini-2.0-flash` is a good default for free-tier usage.

## Run

```bash
python app.py
```
