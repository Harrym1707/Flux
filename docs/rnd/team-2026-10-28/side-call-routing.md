# Side-call routing (round 1, 2026-10-28) — LOSSY candidate

Branch `rnd/2026-10-28-team-side-call-routing`. Reproduce with
`node --import tsx evals/run-team-side-call-routing.ts`.

## Hypothesis

Chat front-ends make auxiliary calls (chat title, tags, follow-up suggestions)
and, on default settings, send them to the chat model itself. Recognising them
by their fixed templates and routing them to a Haiku-class model cuts the
session bill. The main conversation is not touched.

## What the sources say (checked 2026-10-28, open-webui main branch)

- `backend/open_webui/utils/task.py` `get_task_model_id`: starts from the chat's
  own model and swaps only when `TASK_MODEL` / `TASK_MODEL_EXTERNAL` is set.
  Both default to `''` (`config.py`). So on defaults, side-calls bill at the
  chat model's rate. **Verified in source.**
- `ENABLE_TITLE_GENERATION`, `ENABLE_TAGS_GENERATION` and
  `ENABLE_FOLLOW_UP_GENERATION` all default to `True`. Autocomplete defaults to
  off. Search and retrieval query generation are on, but they only fire when
  web search or RAG is in use.
- `src/lib/components/chat/Chat.svelte` `background_tasks`: title and tags are
  requested for a new chat's first exchange only. Follow-ups are requested
  after **every** assistant reply.
- `routers/tasks.py`: each task is sent as a single user message holding the
  rendered template, with `stream: false`. The follow-up template sees the
  first user message plus the last 4 messages, each cut to 1,000 characters.
- LibreChat: `@librechat/agents` `src/utils/title.ts` holds two fixed title
  prompts, which the detector also recognises. LibreChat's default for
  `titleModel` is **not verified**: www.librechat.ai could not be reached from
  this session (blocked by the network allowlist). The example yaml shows
  `titleModel` set by hand. The eval runs a "title only" variant to cover this.

## Fixture basis

The file is `evals/side-call-fixture.ts`. Templates are copied word for word
from Open WebUI `config.py`, and they are rendered the way Open WebUI renders
them (`ROLE: text` lines, END:n windows, follow-up truncation).

- Primary shape: 12 chats, 2.5 turns on average, 42% multi-turn. User messages
  average about 296 tokens and assistant replies about 440. This follows
  WildChat (arXiv 2405.01470, about 2.52 turns and 41% multi-turn). The token
  means come from secondary summaries. **Basis: literature-claim.**
- Two other shapes: LMSYS-like (from the dataset card: 2.0 turns, 69.5 / 214.5
  tokens) and long threads (4 to 20 turns). The long-threads shape is reasoned.
- Side-call output lengths are reasoned, not measured: title 12, tags 20,
  follow-ups 70 tokens.
- 4 of the 30 real user turns are adversarial near-misses, written to look like
  task prompts.

## Measured result (simulator at catalogued prices, fixture shape)

| shape | pair | cache counterfactual | saving |
|---|---|---|---|
| WildChat-like (primary) | Sonnet 5.5 → Haiku 5.5 | uncached (OWUI default) | **35.9%** |
| WildChat-like (primary) | Sonnet 5.5 → Haiku 5.5 | FLUX 5m stamp already on | 44.6% |
| WildChat-like (primary) | gpt-5.5 → gpt-4o-mini | OpenAI automatic cache | 40.3% |
| LMSYS-like | Sonnet → Haiku | uncached / stamped | 55.1% / 56.2% |
| long threads | Sonnet → Haiku | uncached / stamped | 15.2% / 31.8% |
| WildChat-like, title only | Sonnet → Haiku | uncached / stamped | 6.5% / 7.7% |

- Side-calls make up 53.2% of input tokens on the primary fixture. The
  follow-up call is the main cost: it runs on every reply and re-sends about
  400 template tokens plus up to 5 history messages.
- Detector precision on the fixture is 100% (TP 54, FP 0, FN 0, TN 30). The 30
  true negatives include the 4 adversarial near-misses. The test
  `evals/side-call-fixture.test.ts` checks this on all three shapes.
- Lever arms are chosen by running `chooseSideCallRoute` on the rendered
  request bodies. They are not chosen from the fixture labels.

## Implementation

- `packages/sdk-js/src/side-call-routing.ts`:
  - `detectSideCall` matches the template head, the JSON key marker and the
    `<chat_history>…</chat_history>` tail.
  - A match also needs exactly one non-system turn, from the user, with text
    only and no tools. LibreChat's structured title call is the one exception:
    it may carry tools.
- `FluxOptions.sideCallRouting` and `FluxProxyOptions.sideCallRouting` are
  **off by default**.
  - Default kinds are title, tags and follow_ups. Search queries and
    autocomplete are opt-in, because they change what the user actually gets.
  - In `withFlux`, a routed side-call behaves like a routing candidate:
    `qualityCheck` applies, and if the call errors it falls back to the
    requested model.
  - An approved routing policy always wins.
  - The event records `requestedModel`, `routeReason: "side_call_routed"` and
    the signature id.
- **Nothing bills.** The ledger has no routing lever, and this one is lossy: a
  different model writes the title, tags and suggestions. It needs a
  `replayGate` pass on the customer's own traffic before it could ever bill.

## Caveats

1. **Lossy.** The bytes the model reads are unchanged, but a different model
   reads them. Titles and tags are cosmetic. Follow-up suggestions are shown to
   the user, so their quality matters more.
2. The saving holds only for **default** Open WebUI deployments. If an admin
   set a task model or turned the tasks off, the counterfactual saving is 0%.
   The share of the fleet on defaults is unmeasured.
3. The detector has a known limit, pinned in a unit test: a user who pastes a
   whole template word for word as the first turn cannot be told apart from
   the real side-call.
4. No live Open WebUI capture was taken. Token counts use FLUX's approximate
   counter (about ±15%). Reasoning-model "thinking" tokens on side-calls are
   not modelled; they would make the saving larger.
5. Open WebUI's templates change between releases. The detector already
   carries the previous title and follow-up heads, but a new wording would
   silently stop matching. That fails safe: no routing, no harm.

## Next

- Take a live Open WebUI capture through the FLUX proxy, with default
  settings, to measure call frequency and side-call output lengths.
- Run the replay gate on titles, tags and follow-ups with a structural grader
  (valid JSON, right key, item count). The follow-up quality bar needs a
  customer-supplied grader.
- Add a "you are on defaults" diagnostic to the quote and report output:
  detection alone can tell a customer to set `TASK_MODEL_EXTERNAL`. That is
  zero-risk, unbilled advice.
- Add signatures for other front-ends (LobeChat topic summaries, AnythingLLM
  thread naming, and SillyTavern's summarise extension), each checked against
  its source.
