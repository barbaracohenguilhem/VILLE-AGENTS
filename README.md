# 🏡 Ville

A shared house where several LLM‑powered agents live together. Each resident has a
personality, goals, a daily plan, a memory stream and opinions about their housemates.
They move between rooms, do things, talk to each other, reflect on their day, sleep —
and you can walk in and join the conversation.

Residents can run on **different models from different providers at the same time**:
a GPT agent, a Claude agent and a local Llama agent sharing one kitchen.

```
┌──────────────┬────────────────────┬────────────┐
│  🌿 Garden   │   🛋️ Living Room   │ 📚 Library │
├──────────────┼────────────────────┼────────────┤
│  🍳 Kitchen  │     🎨 Studio      │ 🛏️ Bedrooms│
└──────────────┴────────────────────┴────────────┘
```

## Quick start

Requires **Node.js 22.18+** (it runs TypeScript directly — no build step, no runtime dependencies).

```bash
cp .env.example .env     # add at least one API key (see below)
npm start                # → http://localhost:3000
```

Residents need a configured, reachable model to think and talk. Missing keys leave the
selected provider unavailable; Ville never silently substitutes scripted replies. Select
`provider: "offline"` explicitly to run a clearly labelled scripted demo instead.

Open **System** in the top bar to see each resident's model status. A configured connection
starts as **Not checked yet** and becomes **Connected** only after a successful response.
Temporary failures pause decisions with bounded automatic retries; authentication/configuration
failures require fixing setup and restarting Ville. Model calls, HTTP attempts, scripted demo
completions, and blocked attempts are counted separately for the current server session.

| Provider (in `house.json`) | Key / env var | Default model |
|---|---|---|
| `huggingface` | `HF_TOKEN` (optional `HF_BASE_URL`) | `Qwen/Qwen3-4B-Instruct-2507:fastest` |
| `openai` | `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`) | `gpt-6-luna` |
| `anthropic` | `ANTHROPIC_API_KEY` (optional `ANTHROPIC_BASE_URL`) | `claude-haiku-5-5` |
| `openai-compatible` | `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_API_KEY` | `llama3.2` |
| `offline` | — | scripted |

`huggingface` talks to [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers)
at `https://router.huggingface.co/v1`. Create a token with **Make calls to the Inference Providers**
and put it in `HF_TOKEN`. Append `:fastest` or `:cheapest` to a model id to pick a routing policy.

`openai-compatible` works with anything that speaks the Chat Completions protocol:
**Ollama** (`http://localhost:11434/v1`), **OpenRouter**, **Groq**, **Azure AI Foundry**,
LM Studio, vLLM… A resident can also set its own `baseUrl` / `apiKeyEnv` / `model`.

## Using the house

- **Floor plan** — residents drift between rooms; hover for mood/energy/model, click one to
  open their profile: bio, today's plan, relationships, reflections and recent memories.
- **Feed** — everything that happens. Toggle *thoughts* to see their private reasoning.
- **Visitor bar** (bottom) — set your name, pick a room (or click one on the map), choose who
  you're talking to, and say something. Residents remember you.
- **Top bar** — pause/resume time, step one tick while paused, change speed.

Simulated time runs at 15 minutes per tick, one tick every 20 real seconds by default
(≈ 32 real minutes per house‑day). Residents wake and sleep on their own schedules.

State is saved to `data/state.json` and restored on restart. `npm run reset` wipes it.
Set `VILLE_AUTOSTART=0` to open the existing house paused without making model requests.

## Make it yours: `config/house.json`

Everything about the house lives in one file. Restart after editing
(`npm run dev` restarts automatically when `config/` or `src/` change).

### Residents

```jsonc
{
  "name": "Nova",
  "emoji": "🔭",
  "color": "#f5a623",
  "provider": "huggingface",         // huggingface | openai | anthropic | openai-compatible | offline
  "model": "Qwen/Qwen3-4B-Instruct-2507:fastest",  // optional; provider default otherwise
  "params": { "reasoning_effort": "low" },   // optional; merged into the API request
  "age": 31,
  "bio": "An astrophysicist who left academia to write about science…",
  "traits": ["curious", "talkative", "scatterbrained"],
  "style": "Quick, enthusiastic, full of tangents.",
  "goals": ["finish a long article about dark matter", "…"],
  "homeRoom": "bedrooms",            // where they sleep
  "startRoom": "kitchen",            // optional; where they begin
  "wakeHour": 8,
  "sleepHour": 0,                    // may wrap past midnight
  "enabled": true                    // set false to keep them out of the house
}
```

Add as many residents as you like. Each extra awake resident adds LLM calls per tick,
so for a big house raise `tick.realSeconds` or lower `tick.maxActorsPerTick`.

### Rooms

```jsonc
{
  "id": "kitchen",
  "name": "Kitchen",
  "emoji": "🍳",
  "color": "#5c4a1f",
  "description": "the warm heart of the house…",
  "objects": ["coffee machine", "leaky tap", "radio"],
  "x": 0, "y": 4, "w": 4, "h": 4   // rectangle on the floor-plan grid (any size)
}
```

Objects matter: residents are prompted with what's in the room and use it in their actions.

### Pace & memory

```jsonc
"tick":   { "realSeconds": 20, "simMinutes": 15, "maxActorsPerTick": 3, "conversationMaxTurns": 6 },
"memory": { "retrieveTop": 8, "reflectionThreshold": 70, "maxMemories": 400 }
```

## How it works

Loosely modelled on the *Generative Agents* ("Smallville") architecture:

- **Perceive** — anything said or done in a room becomes an observation in each present
  resident's memory stream, scored for importance.
- **Retrieve** — before acting, the most relevant memories are pulled by a blend of recency,
  importance and relevance to the current situation, and placed in the prompt.
- **Act** — the resident's LLM returns one JSON action: `say`, `move`, `do` or `rest`,
  plus a private thought and a mood. Speaking to someone in the room opens a short
  back‑and‑forth conversation resolved immediately (up to `conversationMaxTurns` lines).
- **Relate** — after exchanges, residents update their impression of (and warmth toward)
  the other person; this feeds back into future prompts.
- **Plan** — at the start of each day a resident drafts a loose schedule that guides it.
- **Reflect** — once enough has happened, a resident distils recent memories into a few
  high‑level insights, which become durable, high‑importance memories.

Reflection uses new observations, conversations, and actions rather than feeding old
reflections back into its trigger. Repeated insights do not crowd out witnessed events.
Goal updates require references to actions in the supplied memory evidence; talking about
a goal does not count as completing it. Saved progress from older versions is retained.

All provider calls are plain `fetch` against the REST APIs; unsupported parameters are
detected from 400 responses and dropped automatically, and 429/5xx responses are retried.

## Project layout

```
config/house.json      rooms, residents, pacing — the file you'll edit
src/server.ts          HTTP + Server‑Sent Events
src/world/             clock, house, simulation loop, persistence
src/agents/            memory stream, prompts, Resident
src/llm/               OpenAI / Anthropic / OpenAI‑compatible / offline clients
public/                the browser UI (vanilla HTML/CSS/JS)
```

```bash
npm start          # run
npm run dev        # run with auto-restart on changes
npm run typecheck  # tsc --noEmit
npm test           # offline regression tests; model requests are stubbed
npm run reset      # forget everything and start a fresh day
```
