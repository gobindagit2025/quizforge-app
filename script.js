/* ═══════════════════════════════════════════════════════════════════
   FIX #19: Fisher-Yates shuffle — unbiased, O(n)
   Replaces the biased sort(() => Math.random() - 0.5)
═══════════════════════════════════════════════════════════════════ */
function shuffle(arr) {
  const a = arr.slice(); // do not mutate original
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ═══════════════════════════════════════════════════════════════════
   FIX #20: HTML decode using a single shared DOMParser instance
   More efficient than creating a new <textarea> on every call
═══════════════════════════════════════════════════════════════════ */
const domParser = new DOMParser();
function decodeHTML(str) {
  const doc = domParser.parseFromString(str, 'text/html');
  return doc.documentElement.textContent;
}

/* ═══════════════════════════════════════════════════════════════════
   FIX #3 / #5: Centralized, fully-reset state factory
   PHASES: 'idle' | 'loading' | 'running' | 'answered' | 'finished'
   Every new run starts from the exact same known state — no leftovers.
═══════════════════════════════════════════════════════════════════ */
function createInitialState() {
  return {
    phase:      'idle',
    difficulty: 'easy',
    category:   '0',
    questions:  [],
    current:    0,
    score:      0,
    correct:    0,
    wrong:      0,
    timeLeft:   15,
    totalTime:  15,
  };
}

let state = createInitialState();

/* ═══════════════════════════════════════════════════════════════════
   FIX #1 / #2 / #13: Single timer instance — centrally managed.
   All timer access goes through stopTimer / startTimer ONLY.
   startTimer always calls stopTimer first → no duplicate intervals.
═══════════════════════════════════════════════════════════════════ */
let _timerId = null;

function stopTimer() {
  if (_timerId !== null) {
    clearInterval(_timerId);
    _timerId = null;
  }
}

function startTimer(durationSecs, onTick, onExpire) {
  stopTimer();           // always clear before starting
  onTick(durationSecs); // paint initial state immediately
  _timerId = setInterval(() => {
    durationSecs--;
    onTick(durationSecs);
    if (durationSecs <= 0) {
      stopTimer();
      onExpire();
    }
  }, 1000);
}

/* ═══════════════════════════════════════════════════════════════════
   FIX #10 / #11: Fetch cancellation via AbortController.
   A new fetch always aborts any still-running previous fetch,
   so only the latest request can update state.
═══════════════════════════════════════════════════════════════════ */
let _fetchController = null;

/* ═══════════════════════════════════════════════════════════════════
   DOM REFS — grabbed once at startup, never re-queried in hot paths.
   FIX #8 / #24: eliminates repeated getElementById calls per render.
═══════════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const el = {
  screens: {
    start:   $('start-screen'),
    loading: $('loading-screen'),
    quiz:    $('quiz-screen'),
    result:  $('result-screen'),
  },
  startBtn:     $('start-btn'),
  catSelect:    $('cat-select'),
  loadingMsg:   $('loading-msg'),
  qCurrent:     $('q-current'),
  qTotal:       $('q-total'),
  liveScore:    $('live-score'),
  progressFill: $('progress-fill'),
  timerArc:     $('timer-arc'),
  timerNum:     $('timer-num'),
  timerBar:     $('timer-bar'),
  qBody:        $('q-body'),
  qCategory:    $('q-category'),
  qText:        $('q-text'),
  options:      $('options'),
  diffChip:     $('diff-chip'),
  nextBtn:      $('next-btn'),
  ringFg:       $('ring-fg'),
  ringScore:    $('ring-score'),
  ringTotal:    $('ring-total'),
  statCorrect:  $('stat-correct'),
  statWrong:    $('stat-wrong'),
  statPct:      $('stat-pct'),
  resultEmoji:  $('result-emoji'),
  resultTitle:  $('result-title'),
  resultSub:    $('result-sub'),
  toast:        $('toast'),
  homeBtn:      $('home-btn'),
  restartBtn:   $('restart-btn'),
};

/* ═══════════════════════════════════════════════════════════════════
   SCREEN TRANSITIONS
═══════════════════════════════════════════════════════════════════ */
function showScreen(name) {
  Object.entries(el.screens).forEach(([k, node]) => {
    node.classList.toggle('active', k === name);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   DIFFICULTY SELECTOR
═══════════════════════════════════════════════════════════════════ */
document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.difficulty = btn.dataset.diff;
  });
});

/* ═══════════════════════════════════════════════════════════════════
   START BUTTON
   FIX #28: phase guard prevents re-entry while loading
═══════════════════════════════════════════════════════════════════ */
el.startBtn.addEventListener('click', () => {
  if (state.phase === 'loading') return;
  state.category = el.catSelect.value;
  beginFetch();
});

/* ═══════════════════════════════════════════════════════════════════
   FETCH
   FIX #10 / #11: AbortController cancels stale in-flight requests
   FIX #12: robust error handling with specific messages
   FIX #26: thorough API response validation
═══════════════════════════════════════════════════════════════════ */
function beginFetch() {
  if (_fetchController) _fetchController.abort();
  _fetchController = new AbortController();
  const signal = _fetchController.signal;

  state.phase = 'loading';
  el.loadingMsg.textContent = 'Fetching questions…';
  showScreen('loading');

  const catParam = state.category !== '0' ? `&category=${state.category}` : '';
  const url = `https://opentdb.com/api.php?amount=10&difficulty=${state.difficulty}&type=multiple${catParam}`;

  fetch(url, { signal })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      // FIX #26: comprehensive API response validation
      if (
        !data ||
        data.response_code !== 0 ||
        !Array.isArray(data.results) ||
        data.results.length === 0
      ) {
        throw new Error('no_questions');
      }

      // FIX #27: decode all fields for full special-character coverage
      const questions = data.results.map(q => ({
        category: decodeHTML(q.category),
        question: decodeHTML(q.question),
        correct:  decodeHTML(q.correct_answer),
        options:  shuffle([q.correct_answer, ...q.incorrect_answers].map(decodeHTML)),
      }));

      // FIX #5: preserve user preferences, reset everything else
      const diff = state.difficulty;
      const cat  = state.category;
      state            = createInitialState();
      state.difficulty = diff;
      state.category   = cat;
      state.questions  = questions;
      state.phase      = 'running';

      showScreen('quiz');
      renderQuestion();
    })
    .catch(err => {
      if (err.name === 'AbortError') return; // intentionally cancelled — silent exit
      const msg = err.message === 'no_questions'
        ? 'Not enough questions — try a different category.'
        : 'Network error. Please try again.';
      el.loadingMsg.textContent = msg;
      state.phase = 'idle';
      setTimeout(() => showScreen('start'), 2500);
    });
}

/* ═══════════════════════════════════════════════════════════════════
   RENDER QUESTION
   FIX #4:  answered state lives in `phase`, not a loose boolean
   FIX #6:  options use a single delegated listener (attached once below)
   FIX #7:  DocumentFragment for batch DOM insertion
   FIX #9:  requestAnimationFrame replaces forced-reflow hack
   FIX #15: time-per-difficulty centralized in one lookup object
═══════════════════════════════════════════════════════════════════ */
function renderQuestion() {
  const q     = state.questions[state.current];
  const total = state.questions.length;

  // Header
  el.qCurrent.textContent  = state.current + 1;
  el.qTotal.textContent    = total;
  el.liveScore.textContent = state.score;

  // Progress
  el.progressFill.style.width = ((state.current / total) * 100) + '%';

  // Difficulty chip
  el.diffChip.textContent = state.difficulty;
  el.diffChip.className   = `diff-chip ${state.difficulty}`;

  // Slide-in animation — clean rAF approach, no forced reflow
  el.qBody.classList.remove('q-animate-in');
  requestAnimationFrame(() => el.qBody.classList.add('q-animate-in'));

  el.qCategory.textContent = q.category;
  el.qText.textContent     = q.question; // textContent: XSS-safe

  // FIX #24: DocumentFragment — one DOM mutation, no incremental reflow
  const letters = ['A', 'B', 'C', 'D'];
  const frag    = document.createDocumentFragment();
  q.options.forEach((opt, i) => {
    const div    = document.createElement('div');
    div.className    = 'option';
    div.dataset.index = i;

    const letter = document.createElement('div');
    letter.className   = 'opt-letter';
    letter.textContent = letters[i];

    const text = document.createElement('div');
    text.className   = 'opt-text';
    text.textContent = opt; // textContent: XSS-safe

    const icon = document.createElement('span');
    icon.className = 'opt-icon';

    div.appendChild(letter);
    div.appendChild(text);
    div.appendChild(icon);
    frag.appendChild(div);
  });
  el.options.innerHTML = '';     // clear previous options
  el.options.appendChild(frag); // single DOM insertion

  // Next button
  el.nextBtn.disabled    = true;
  el.nextBtn.textContent = state.current < total - 1 ? 'Next →' : 'Finish ✓';

  // FIX #15: centralized time-per-difficulty
  const timeForDiff = { easy: 15, medium: 15, hard: 15 };
  state.totalTime = timeForDiff[state.difficulty] ?? 15;
  state.timeLeft  = state.totalTime;

  startTimer(
    state.totalTime,
    t => {
      state.timeLeft = t;
      updateTimerUI(t, state.totalTime);
    },
    onTimerExpire
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TIMER UI
   FIX #13: pure function — only updates the DOM, never touches state
   FIX #25: minimal work — only recomputes what changes each second
═══════════════════════════════════════════════════════════════════ */
function updateTimerUI(t, total) {
  const ratio  = t / total;
  const offset = 113 * (1 - ratio);
  const colour = ratio > .5 ? 'var(--accent)' : ratio > .25 ? 'var(--gold)' : 'var(--error)';

  el.timerNum.textContent             = t;
  el.timerArc.style.strokeDashoffset  = offset;
  el.timerArc.style.stroke            = colour;
  el.timerBar.style.width             = (ratio * 100) + '%';
  el.timerBar.style.background        = colour;
}

/* ═══════════════════════════════════════════════════════════════════
   TIMER EXPIRE
   FIX #14 / #17: phase guard ensures this is a no-op if the player
   already answered before the interval fired.
═══════════════════════════════════════════════════════════════════ */
function onTimerExpire() {
  if (state.phase !== 'running') return;
  state.phase = 'answered';
  state.wrong++;
  revealAnswer(null); // null = timeout, no player-chosen wrong element
  showToast("⏱ Time's up!", 'incorrect');
  el.nextBtn.disabled = false;
}

/* ═══════════════════════════════════════════════════════════════════
   OPTION CLICK — single delegated listener on the container.
   FIX #6:  attached once at init, survives innerHTML clears
   FIX #16 / #17 / #18: all guards in one place
═══════════════════════════════════════════════════════════════════ */
el.options.addEventListener('click', e => {
  const optEl = e.target.closest('.option'); // FIX #18: ignore non-option clicks
  if (!optEl) return;
  if (state.phase !== 'running') return;     // FIX #17: phase guard

  stopTimer(); // FIX #1: immediately kill the timer
  state.phase = 'answered';

  const q      = state.questions[state.current];
  const idx    = parseInt(optEl.dataset.index, 10);
  const chosen = q.options[idx];
  const isRight = chosen === q.correct;

  if (isRight) {
    const timeBonus = Math.ceil((state.timeLeft / state.totalTime) * 10);
    const pts       = 10 + timeBonus;
    state.score  += pts;
    state.correct++;
    showToast(`✓ Correct! +${pts} pts`, 'correct');
  } else {
    state.wrong++;
    showToast('✗ Wrong answer', 'incorrect');
  }

  el.liveScore.textContent = state.score;
  revealAnswer(isRight ? null : optEl);
  el.nextBtn.disabled = false;
});

/* ═══════════════════════════════════════════════════════════════════
   REVEAL ANSWER
   Marks correct option green and (if provided) the wrong choice red.
   Called by both player interaction and timer expiry.
═══════════════════════════════════════════════════════════════════ */
function revealAnswer(wrongEl) {
  const q = state.questions[state.current];
  el.options.querySelectorAll('.option').forEach(opt => {
    opt.classList.add('locked');
    const i    = parseInt(opt.dataset.index, 10);
    const icon = opt.querySelector('.opt-icon');
    if (q.options[i] === q.correct) {
      opt.classList.add('correct');
      icon.textContent = '✓';
    }
  });
  if (wrongEl) {
    wrongEl.classList.add('incorrect');
    wrongEl.querySelector('.opt-icon').textContent = '✗';
  }
}

/* ═══════════════════════════════════════════════════════════════════
   NEXT BUTTON
   FIX #16: disabled attribute is the single enable/disable authority
   FIX #18: early return if disabled prevents double-clicks
═══════════════════════════════════════════════════════════════════ */
el.nextBtn.addEventListener('click', () => {
  if (el.nextBtn.disabled) return;
  stopTimer();

  if (state.current < state.questions.length - 1) {
    state.current++;
    state.phase = 'running';
    renderQuestion();
  } else {
    state.phase = 'finished';
    showResult();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   RESULT SCREEN
═══════════════════════════════════════════════════════════════════ */
function showResult() {
  showScreen('result');

  const total  = state.questions.length;
  const pct    = Math.round((state.correct / total) * 100);
  const offset = 314 * (1 - state.correct / total);

  el.ringFg.style.stroke = pct >= 70 ? 'var(--success)' : pct >= 40 ? 'var(--gold)' : 'var(--error)';
  setTimeout(() => { el.ringFg.style.strokeDashoffset = offset; }, 100);

  el.ringScore.textContent   = state.correct;
  el.ringTotal.textContent   = `/ ${total}`;
  el.statCorrect.textContent = state.correct;
  el.statWrong.textContent   = state.wrong;
  el.statPct.textContent     = pct + '%';

  let emoji, title, sub;
  if      (pct === 100) { emoji = '🏆'; title = 'Perfect Score!';          sub = 'Absolutely flawless. Are you even human?'; }
  else if (pct >= 80)   { emoji = '🎉'; title = 'Excellent!';              sub = 'You really know your stuff.'; }
  else if (pct >= 60)   { emoji = '👍'; title = 'Good Job!';               sub = 'Solid performance. Room to grow!'; }
  else if (pct >= 40)   { emoji = '🤔'; title = 'Keep Trying';             sub = "You're halfway there. Practice makes perfect."; }
  else                  { emoji = '😅'; title = 'Better Luck Next Time';   sub = 'Every expert was once a beginner.'; }

  el.resultEmoji.textContent = emoji;
  el.resultTitle.textContent = title;
  el.resultSub.textContent   = sub;
}

/* ═══════════════════════════════════════════════════════════════════
   HOME / RESTART
   FIX #28: phase guard prevents button spam during loading
═══════════════════════════════════════════════════════════════════ */
el.homeBtn.addEventListener('click', () => {
  if (state.phase === 'loading') return;
  stopTimer();
  if (_fetchController) { _fetchController.abort(); _fetchController = null; }
  const diff = state.difficulty;
  const cat  = state.category;
  state            = createInitialState();
  state.difficulty = diff;
  state.category   = cat;
  showScreen('start');
});

el.restartBtn.addEventListener('click', () => {
  if (state.phase === 'loading') return;
  stopTimer();
  beginFetch();
});

/* ═══════════════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════════════ */
let _toastTimer = null;
function showToast(msg, type) {
  clearTimeout(_toastTimer);
  el.toast.textContent = msg;
  el.toast.className   = `toast ${type}-toast show`;
  _toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800);
}