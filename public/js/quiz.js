// ===== صفحة الممتحن =====
import { db } from "./firebase.js";
import { SITE_NAME } from "./config.js";
import {
  doc, getDoc, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  normalizeName, cleanDisplayName, escapeHtml, store, confirmDialog, toast
} from "./common.js";

const app = document.getElementById("app");
document.querySelectorAll("[data-site-name]").forEach((el) => (el.textContent = SITE_NAME));

// معرّف الاختبار من الرابط: /q/ABC123 (أو ?id=ABC123 احتياطًا)
function getQuizId() {
  const match = location.pathname.match(/\/q\/([A-Za-z0-9]+)/);
  const raw = match ? match[1] : new URLSearchParams(location.search).get("id");
  if (!raw || !/^[A-Za-z0-9]{4,12}$/.test(raw)) return null;
  return raw.toUpperCase();
}

const quizId = getQuizId();
const DONE_KEY = `nq_done_${quizId}`;      // نتيجة سابقة على هذا الجهاز
const PROGRESS_KEY = `nq_progress_${quizId}`; // تقدّم غير مكتمل

let quiz = null;      // { title, questions }
let progress = null;  // { name, nameKey, answers, index, sig }

// بصمة بسيطة للأسئلة لمعرفة هل عُدّل الاختبار بعد بدء التقدم
function questionsSignature(questions) {
  const s = JSON.stringify(questions.map((q) => [q.text, q.options]));
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

function questionsWord(n) {
  if (n === 1) return "سؤال";
  if (n === 2) return "سؤالين";
  if (n >= 3 && n <= 10) return "أسئلة";
  return "سؤالًا";
}

function isNetworkError(err) {
  const code = String(err?.code || "");
  return !navigator.onLine || code.includes("unavailable") || code.includes("deadline");
}

// ===== الشاشات =====

function showLoading(text) {
  app.innerHTML = `
    <div class="loading">
      <div class="spinner" aria-hidden="true"></div>
      <div>${escapeHtml(text)}</div>
    </div>`;
}

function showUnavailable() {
  document.title = SITE_NAME;
  app.innerHTML = `
    <div class="card card-accent center">
      <div class="big-icon" aria-hidden="true">📖</div>
      <h1>هذا الاختبار غير متاح حاليًا</h1>
      <p class="muted">قد يكون الرابط غير صحيح، أو أن الاختبار أُوقف. تواصل مع من أرسل لك الرابط.</p>
    </div>`;
}

function showError(message, retry) {
  app.innerHTML = `
    <div class="card center">
      <div class="big-icon" aria-hidden="true">⚠️</div>
      <div class="alert alert-error">${escapeHtml(message)}</div>
      <button class="btn btn-primary btn-block" id="retry">حاول مرة أخرى</button>
    </div>`;
  document.getElementById("retry").onclick = retry;
}

function showStart(errorMessage = "", prefillName = "") {
  const n = quiz.questions.length;
  app.innerHTML = `
    <div class="card card-accent">
      <h1 class="quiz-title">${escapeHtml(quiz.title)}</h1>
      <p class="quiz-meta">عدد الأسئلة: <strong>${n}</strong></p>
      <form id="start-form" novalidate>
        <div class="field">
          <label for="name">اسمك الكامل</label>
          <input type="text" id="name" autocomplete="name" maxlength="100"
                 placeholder="مثال: محمد أحمد علي" value="${escapeHtml(prefillName)}">
          <div class="field-hint">اكتب اسمك الكامل (كلمتان على الأقل).</div>
        </div>
        <div id="start-error" class="alert alert-error" ${errorMessage ? "" : "hidden"}>${escapeHtml(errorMessage)}</div>
        <button type="submit" class="btn btn-primary btn-block" id="start-btn">ابدأ الاختبار</button>
      </form>
      <p class="muted center" style="margin-top:16px;font-size:0.95rem">يمكنك أداء الاختبار مرة واحدة فقط.</p>
    </div>`;

  const form = document.getElementById("start-form");
  const input = document.getElementById("name");
  const errBox = document.getElementById("start-error");
  const btn = document.getElementById("start-btn");

  const setError = (msg) => {
    errBox.textContent = msg;
    errBox.hidden = !msg;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = cleanDisplayName(input.value);
    const nameKey = normalizeName(name);
    const words = nameKey.split(" ").filter(Boolean);
    if (words.length < 2 || nameKey.replace(/ /g, "").length < 3) {
      setError("من فضلك اكتب اسمك الكامل (كلمتان على الأقل).");
      input.focus();
      return;
    }
    setError("");
    btn.disabled = true;
    btn.textContent = "جارٍ التحقق من الاسم...";
    try {
      const snap = await getDoc(doc(db, "quizzes", quizId, "names", nameKey));
      if (snap.exists()) {
        setError("هذا الاسم أدّى الاختبار مسبقًا.");
        btn.disabled = false;
        btn.textContent = "ابدأ الاختبار";
        return;
      }
    } catch (err) {
      setError(isNetworkError(err)
        ? "تعذّر الاتصال بالإنترنت. تأكد من الاتصال ثم حاول مرة أخرى."
        : "حدث خطأ أثناء التحقق من الاسم. حاول مرة أخرى.");
      btn.disabled = false;
      btn.textContent = "ابدأ الاختبار";
      return;
    }

    // إن وُجدت إجابات سابقة لم تُرسل (مثلًا بعد تغيير الاسم) نحتفظ بها
    const sig = questionsSignature(quiz.questions);
    const keepAnswers = progress && progress.sig === sig ? progress.answers : null;
    progress = {
      name,
      nameKey,
      sig,
      answers: keepAnswers || new Array(quiz.questions.length).fill(null),
      index: 0
    };
    if (keepAnswers) {
      const firstEmpty = keepAnswers.findIndex((a) => a === null);
      progress.index = firstEmpty === -1 ? keepAnswers.length - 1 : firstEmpty;
    }
    saveProgress();
    showQuestion();
  };
}

function saveProgress() {
  store.set(PROGRESS_KEY, progress);
}

function showQuestion() {
  const total = quiz.questions.length;
  const i = progress.index;
  const q = quiz.questions[i];
  const selected = progress.answers[i];
  const isLast = i === total - 1;
  const percent = Math.round(((i + 1) / total) * 100);

  app.innerHTML = `
    <div class="card">
      <div class="progress-label">
        <span>السؤال ${i + 1} من ${total}</span>
      </div>
      <div class="progress" role="progressbar" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${i + 1}">
        <div class="progress-bar" style="width:${percent}%"></div>
      </div>
      <h1 class="question-text" id="q-text">${escapeHtml(q.text)}</h1>
      <div class="options" role="radiogroup" aria-labelledby="q-text">
        ${q.options.map((opt, idx) => `
          <button type="button" class="option ${selected === idx ? "selected" : ""}"
                  role="radio" aria-checked="${selected === idx}" data-idx="${idx}">
            <span class="mark" aria-hidden="true"></span>
            <span>${escapeHtml(opt)}</span>
          </button>`).join("")}
      </div>
      <div class="nav-buttons">
        <button type="button" class="btn btn-light" id="prev" ${i === 0 ? "disabled" : ""}>السابق</button>
        <button type="button" class="btn btn-primary btn-next" id="next" ${selected === null ? "disabled" : ""}>
          ${isLast ? "إنهاء وإرسال" : "التالي"}
        </button>
      </div>
      <p class="muted center" id="hint" style="margin-top:14px;font-size:0.95rem" ${selected === null ? "" : "hidden"}>
        اختر إجابة للمتابعة.
      </p>
    </div>`;

  app.querySelectorAll(".option").forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.idx);
      progress.answers[i] = idx;
      saveProgress();
      app.querySelectorAll(".option").forEach((b) => {
        const on = Number(b.dataset.idx) === idx;
        b.classList.toggle("selected", on);
        b.setAttribute("aria-checked", String(on));
      });
      document.getElementById("next").disabled = false;
      document.getElementById("hint").hidden = true;
    };
  });

  document.getElementById("prev").onclick = () => {
    if (progress.index > 0) {
      progress.index--;
      saveProgress();
      showQuestion();
      window.scrollTo(0, 0);
    }
  };

  document.getElementById("next").onclick = async () => {
    if (progress.answers[i] === null) return;
    if (!isLast) {
      progress.index++;
      saveProgress();
      showQuestion();
      window.scrollTo(0, 0);
      return;
    }
    const ok = await confirmDialog(
      "هل أنت متأكد من إنهاء الاختبار وإرسال إجاباتك؟\nلا يمكن تغيير الإجابات بعد الإرسال.",
      { okText: "نعم، أرسل الإجابات", cancelText: "رجوع للمراجعة", title: "إنهاء الاختبار" }
    );
    if (ok) submit();
  };
}

async function submit() {
  const total = quiz.questions.length;
  const answers = progress.answers.map((a) => (a === null ? -1 : a));
  const score = quiz.questions.reduce((sum, q, idx) => sum + (answers[idx] === q.correct ? 1 : 0), 0);

  if (!navigator.onLine) {
    toast("لا يوجد اتصال بالإنترنت. اتصل ثم اضغط «إنهاء وإرسال» مرة أخرى.", "error");
    return;
  }

  showLoading("جارٍ إرسال إجاباتك...");
  const slowTimer = setTimeout(() => {
    showLoading("الاتصال بطيء، يرجى الانتظار وعدم إغلاق الصفحة...");
  }, 10000);

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "quizzes", quizId, "submissions", progress.nameKey), {
      name: progress.name,
      answers,
      score,
      total,
      createdAt: serverTimestamp()
    });
    batch.set(doc(db, "quizzes", quizId, "names", progress.nameKey), {
      createdAt: serverTimestamp()
    });
    await batch.commit();
    clearTimeout(slowTimer);

    const done = {
      name: progress.name,
      nameKey: progress.nameKey,
      title: quiz.title,
      questions: quiz.questions,
      answers,
      score,
      total,
      at: Date.now()
    };
    store.set(DONE_KEY, done);
    store.remove(PROGRESS_KEY);
    showResult(done, true);
  } catch (err) {
    clearTimeout(slowTimer);
    if (isNetworkError(err)) {
      showError("تعذّر إرسال الإجابات بسبب الاتصال. إجاباتك محفوظة على جهازك، حاول مرة أخرى.", () => showQuestion());
      return;
    }
    // الرفض غالبًا يعني أن الاسم مستخدم، أو أن الاختبار أُوقف
    try {
      const nameSnap = await getDoc(doc(db, "quizzes", quizId, "names", progress.nameKey));
      if (nameSnap.exists()) {
        showStart("هذا الاسم أدّى الاختبار مسبقًا. إجاباتك محفوظة، اكتب اسمك الكامل بشكل مختلف إن كان شخصًا آخر.", progress.name);
        return;
      }
      const quizSnap = await getDoc(doc(db, "quizzes", quizId));
      if (!quizSnap.exists() || quizSnap.data().active !== true) {
        showUnavailable();
        return;
      }
    } catch (e2) {
      if (String(e2?.code || "").includes("permission-denied")) {
        showUnavailable();
        return;
      }
    }
    showError("تعذّر إرسال الإجابات. إجاباتك محفوظة على جهازك، حاول مرة أخرى.", () => showQuestion());
  }
}

function showResult(done, justSubmitted = false) {
  document.title = `${done.title} — ${SITE_NAME}`;
  const items = done.questions.map((q, idx) => {
    const ans = done.answers[idx];
    const ok = ans === q.correct;
    const yours = ans >= 0 && ans < q.options.length ? q.options[ans] : "لم تُجب";
    return `
      <div class="review-item ${ok ? "is-correct" : "is-wrong"}">
        <div class="review-q">${idx + 1}. ${escapeHtml(q.text)}</div>
        <div class="review-ans ${ok ? "correct" : "wrong"}">
          <span class="lbl">${ok ? "✓ إجابتك صحيحة:" : "✗ إجابتك:"}</span> ${escapeHtml(yours)}
        </div>
        ${ok ? "" : `
        <div class="review-ans correct">
          <span class="lbl">الإجابة الصحيحة:</span> ${escapeHtml(q.options[q.correct])}
        </div>`}
      </div>`;
  }).join("");

  app.innerHTML = `
    ${justSubmitted ? `<div class="alert alert-success center">تم إرسال إجاباتك بنجاح. جزاك الله خيرًا.</div>` : `
      <div class="alert alert-info center">لقد أدّيت هذا الاختبار من قبل. هذه نتيجتك.</div>`}
    <div class="score-box">
      <div class="score-big">أجبت إجابة صحيحة على ${done.score} من ${done.total} ${questionsWord(done.total)}</div>
      <div class="score-name">${escapeHtml(done.name)} — ${escapeHtml(done.title)}</div>
    </div>
    <h2>مراجعة الإجابات</h2>
    ${items}`;
  window.scrollTo(0, 0);
}

// ===== البداية =====

async function init() {
  if (!quizId) {
    showUnavailable();
    return;
  }

  // 1) هل أدّى هذا الجهاز الاختبار من قبل؟
  const done = store.get(DONE_KEY);
  if (done && Array.isArray(done.questions)) {
    try {
      const snap = await getDoc(doc(db, "quizzes", quizId, "names", done.nameKey || normalizeName(done.name)));
      if (snap.exists()) {
        showResult(done);
        return;
      }
      // حذف المدير النتيجة: يُسمح بإعادة الاختبار
      store.remove(DONE_KEY);
      store.remove(PROGRESS_KEY);
    } catch {
      // بدون اتصال: نعرض النتيجة المحفوظة
      showResult(done);
      return;
    }
  }

  // 2) تحميل الاختبار
  showLoading("جارٍ تحميل الاختبار...");
  let snap;
  try {
    snap = await getDoc(doc(db, "quizzes", quizId));
  } catch (err) {
    if (String(err?.code || "").includes("permission-denied")) {
      showUnavailable();
    } else {
      showError("تعذّر تحميل الاختبار. تأكد من اتصالك بالإنترنت ثم حاول مرة أخرى.", init);
    }
    return;
  }
  if (!snap.exists() || snap.data().active !== true) {
    showUnavailable();
    return;
  }
  const data = snap.data();
  quiz = {
    title: data.title || "اختبار",
    questions: Array.isArray(data.questions) ? data.questions : []
  };
  if (quiz.questions.length === 0) {
    showUnavailable();
    return;
  }
  document.title = `${quiz.title} — ${SITE_NAME}`;

  // 3) هل هناك تقدّم محفوظ؟
  const saved = store.get(PROGRESS_KEY);
  const sig = questionsSignature(quiz.questions);
  if (saved && saved.sig === sig && Array.isArray(saved.answers) &&
      saved.answers.length === quiz.questions.length && saved.nameKey) {
    progress = saved;
    progress.index = Math.min(Math.max(0, progress.index || 0), quiz.questions.length - 1);
    showQuestion();
    toast("أكملنا من حيث توقفت.", "success");
    return;
  }
  if (saved) store.remove(PROGRESS_KEY);

  showStart();
}

init();
