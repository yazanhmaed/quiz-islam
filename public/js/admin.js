// ===== لوحة التحكم (للمدير فقط) =====
import { db, auth } from "./firebase.js";
import { SITE_NAME, ADMIN_EMAIL } from "./config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch,
  query, orderBy, serverTimestamp, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  escapeHtml, toast, confirmDialog, friendlyError, formatDateTime, toDate
} from "./common.js";

const app = document.getElementById("app");
const logoutBtn = document.getElementById("logout-btn");
document.querySelectorAll("[data-site-name]").forEach((el) => (el.textContent = SITE_NAME));

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
const ID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // بدون الأحرف المتشابهة (O/0, I/1, L)

let currentUser = null;
let editor = null;        // حالة محرر الاختبار
let ignoreHashChange = false;
let lastHash = location.hash;

// ===== أدوات =====

function quizUrl(id) {
  return `${location.origin}/q/${id}`;
}

function showLoading(text = "جارٍ التحميل...") {
  app.innerHTML = `
    <div class="loading">
      <div class="spinner" aria-hidden="true"></div>
      <div>${escapeHtml(text)}</div>
    </div>`;
}

function showErrorBox(message, retry) {
  app.innerHTML = `
    <div class="card center">
      <div class="big-icon" aria-hidden="true">⚠️</div>
      <div class="alert alert-error">${escapeHtml(message)}</div>
      <div class="btn-row">
        <button class="btn btn-primary" id="retry">حاول مرة أخرى</button>
        <a class="btn btn-light" href="#/">الرئيسية</a>
      </div>
    </div>`;
  document.getElementById("retry").onclick = retry;
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function shareQuiz(title, id) {
  const url = quizUrl(id);
  const text = `${title}\nاضغط على الرابط لبدء الاختبار:`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  // بديل: فتح واتساب مباشرة
  window.open(`https://wa.me/?text=${encodeURIComponent(text + "\n" + url)}`, "_blank", "noopener");
}

async function generateQuizId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = crypto.getRandomValues(new Uint32Array(6));
    const id = Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join("");
    const snap = await getDoc(doc(db, "quizzes", id));
    if (!snap.exists()) return id;
  }
  throw new Error("تعذّر إنشاء معرّف للاختبار");
}

async function countSubmissions(quizId) {
  try {
    const snap = await getCountFromServer(collection(db, "quizzes", quizId, "submissions"));
    return snap.data().count;
  } catch {
    return null;
  }
}

// حذف كل مستندات مجموعة فرعية على دفعات
async function deleteSubcollection(quizId, name) {
  const snap = await getDocs(collection(db, "quizzes", quizId, name));
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// ===== تسجيل الدخول =====

function showLogin(errorMessage = "") {
  logoutBtn.hidden = true;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="card card-accent">
        <h1 class="center">لوحة التحكم</h1>
        <p class="muted center">سجّل الدخول بحساب المدير.</p>
        <form id="login-form" novalidate>
          <div class="field">
            <label for="email">الإيميل</label>
            <input type="email" id="email" autocomplete="username" inputmode="email" required>
          </div>
          <div class="field">
            <label for="password">كلمة المرور</label>
            <input type="password" id="password" autocomplete="current-password" required>
          </div>
          <div class="alert alert-error" id="login-error" ${errorMessage ? "" : "hidden"}>${escapeHtml(errorMessage)}</div>
          <button type="submit" class="btn btn-primary btn-block" id="login-btn">دخول</button>
        </form>
      </div>
    </div>`;

  const form = document.getElementById("login-form");
  const errBox = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    if (!email || !password) {
      errBox.textContent = "اكتب الإيميل وكلمة المرور.";
      errBox.hidden = false;
      return;
    }
    errBox.hidden = true;
    btn.disabled = true;
    btn.textContent = "جارٍ الدخول...";
    try {
      await setPersistence(auth, browserLocalPersistence); // يبقى الدخول محفوظًا على الجهاز
      await signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged يكمل الباقي
    } catch (err) {
      errBox.textContent = friendlyError(err);
      errBox.hidden = false;
      btn.disabled = false;
      btn.textContent = "دخول";
    }
  };
}

logoutBtn.onclick = async () => {
  const ok = await confirmDialog("هل تريد تسجيل الخروج؟", { okText: "تسجيل الخروج" });
  if (!ok) return;
  editor = null;
  await signOut(auth);
  history.replaceState(null, "", location.pathname);
};

// ===== قائمة الاختبارات =====

let quizList = []; // [{ id, title, questionsCount, active, count }]

async function showList() {
  editor = null;
  document.title = `لوحة التحكم — ${SITE_NAME}`;
  showLoading("جارٍ تحميل الاختبارات...");
  try {
    const snap = await getDocs(query(collection(db, "quizzes"), orderBy("createdAt", "desc")));
    quizList = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        title: data.title || "بدون عنوان",
        questionsCount: Array.isArray(data.questions) ? data.questions.length : 0,
        active: data.active === true,
        count: null
      };
    });
  } catch (err) {
    showErrorBox("تعذّر تحميل الاختبارات. " + friendlyError(err), showList);
    return;
  }
  renderList();
  // جلب عدد الممتحنين لكل اختبار
  await Promise.all(quizList.map(async (q) => {
    q.count = await countSubmissions(q.id);
    const el = document.querySelector(`[data-count="${q.id}"]`);
    if (el) el.textContent = q.count === null ? "—" : q.count;
  }));
}

function renderList() {
  const cards = quizList.map((q) => `
    <div class="card quiz-card">
      <h3>${escapeHtml(q.title)}</h3>
      <div class="quiz-stats">
        <span class="badge ${q.active ? "badge-on" : "badge-off"}">${q.active ? "مفعّل" : "موقوف"}</span>
        <span>عدد الأسئلة: <strong>${q.questionsCount}</strong></span>
        <span>عدد الممتحنين: <strong data-count="${q.id}">${q.count === null ? "…" : q.count}</strong></span>
      </div>
      <div class="quiz-link">${escapeHtml(quizUrl(q.id))}</div>
      <div class="actions-grid">
        <button class="btn btn-outline" data-act="copy" data-id="${q.id}">📋 نسخ الرابط</button>
        <button class="btn btn-primary" data-act="share" data-id="${q.id}">📤 مشاركة</button>
        <button class="btn btn-gold" data-act="results" data-id="${q.id}">📊 النتائج</button>
        <button class="btn btn-outline" data-act="edit" data-id="${q.id}">✏️ تعديل</button>
        <button class="btn btn-light" data-act="toggle" data-id="${q.id}">${q.active ? "⏸️ إيقاف" : "▶️ تفعيل"}</button>
        <button class="btn btn-danger-outline" data-act="delete" data-id="${q.id}">🗑️ حذف</button>
      </div>
    </div>`).join("");

  app.innerHTML = `
    <div class="page-head">
      <h2>الاختبارات</h2>
    </div>
    <button class="btn btn-primary btn-block" id="new-quiz" style="margin-bottom:20px">➕ إنشاء اختبار جديد</button>
    ${quizList.length ? cards : `
      <div class="card empty-state">
        <div class="big-icon" aria-hidden="true">📝</div>
        <p>لا توجد اختبارات بعد.</p>
        <p>اضغط «إنشاء اختبار جديد» للبدء.</p>
      </div>`}`;

  document.getElementById("new-quiz").onclick = () => go("#/new");
  app.querySelectorAll("[data-act]").forEach((btn) => {
    btn.onclick = () => handleListAction(btn.dataset.act, btn.dataset.id, btn);
  });
}

async function handleListAction(action, id, btn) {
  const q = quizList.find((x) => x.id === id);
  if (!q) return;

  if (action === "copy") {
    const ok = await copyText(quizUrl(id));
    toast(ok ? "تم نسخ الرابط ✓" : "تعذّر النسخ، انسخ الرابط يدويًا.", ok ? "success" : "error");
  } else if (action === "share") {
    if (!q.active) toast("تنبيه: هذا الاختبار موقوف ولن يفتح للممتحنين.", "error");
    shareQuiz(q.title, id);
  } else if (action === "results") {
    go(`#/results/${id}`);
  } else if (action === "edit") {
    go(`#/edit/${id}`);
  } else if (action === "toggle") {
    const next = !q.active;
    if (!next) {
      const ok = await confirmDialog(`هل تريد إيقاف اختبار «${q.title}»؟\nلن يتمكن أحد من فتحه حتى تفعّله مرة أخرى.`, { okText: "نعم، أوقفه" });
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      await updateDoc(doc(db, "quizzes", id), { active: next });
      q.active = next;
      toast(next ? "تم تفعيل الاختبار ✓" : "تم إيقاف الاختبار", "success");
      renderList();
    } catch (err) {
      btn.disabled = false;
      toast(friendlyError(err), "error");
    }
  } else if (action === "delete") {
    const ok = await confirmDialog(
      `هل أنت متأكد من حذف اختبار «${q.title}»؟\nسيتم حذف الاختبار وكل نتائجه نهائيًا ولا يمكن التراجع.`,
      { okText: "نعم، احذف نهائيًا", danger: true, title: "حذف الاختبار" }
    );
    if (!ok) return;
    showLoading("جارٍ حذف الاختبار ونتائجه...");
    try {
      await deleteSubcollection(id, "submissions");
      await deleteSubcollection(id, "names");
      await deleteDoc(doc(db, "quizzes", id));
      quizList = quizList.filter((x) => x.id !== id);
      toast("تم حذف الاختبار", "success");
      renderList();
    } catch (err) {
      toast("تعذّر الحذف. " + friendlyError(err), "error");
      showList();
    }
  }
}

// ===== إنشاء وتعديل اختبار =====

function emptyQuestion() {
  return { text: "", options: ["", ""], correct: -1, error: "" };
}

async function showEditor(id) {
  document.title = `${id ? "تعديل اختبار" : "اختبار جديد"} — ${SITE_NAME}`;
  if (!id) {
    editor = { id: null, title: "", questions: [emptyQuestion()], submissions: 0, dirty: false, saving: false };
    renderEditor();
    return;
  }
  showLoading("جارٍ تحميل الاختبار...");
  try {
    const snap = await getDoc(doc(db, "quizzes", id));
    if (!snap.exists()) {
      showErrorBox("هذا الاختبار غير موجود. ربما حُذف.", () => go("#/"));
      return;
    }
    const data = snap.data();
    const submissions = (await countSubmissions(id)) || 0;
    editor = {
      id,
      title: data.title || "",
      questions: (data.questions || []).map((q) => ({
        text: q.text || "",
        options: Array.isArray(q.options) && q.options.length >= 2 ? [...q.options] : ["", ""],
        correct: typeof q.correct === "number" ? q.correct : -1,
        error: ""
      })),
      submissions,
      dirty: false,
      saving: false
    };
    if (editor.questions.length === 0) editor.questions.push(emptyQuestion());
    renderEditor();
  } catch (err) {
    showErrorBox("تعذّر تحميل الاختبار. " + friendlyError(err), () => showEditor(id));
  }
}

function renderEditor() {
  const e = editor;
  app.innerHTML = `
    <div class="page-head">
      <h2>${e.id ? "تعديل الاختبار" : "اختبار جديد"}</h2>
      <button class="btn btn-light btn-small" id="back-btn">→ رجوع</button>
    </div>
    ${e.submissions > 0 ? `
      <div class="alert alert-warn">
        ⚠️ هذا الاختبار أدّاه <strong>${e.submissions}</strong> شخص من قبل.
        تعديل الأسئلة أو ترتيبها أو الإجابات الصحيحة قد يجعل مراجعة النتائج السابقة غير دقيقة (الدرجات المحفوظة لن تتغير).
      </div>` : ""}
    <div class="card card-accent">
      <div class="field" style="margin-bottom:0">
        <label for="quiz-title">عنوان الاختبار</label>
        <input type="text" id="quiz-title" maxlength="150" placeholder="مثال: اختبار السيرة النبوية" value="${escapeHtml(e.title)}">
        <div class="q-error" id="title-error" hidden></div>
      </div>
    </div>
    <p class="muted">اضغط على الدائرة بجانب الخيار لتحديده كإجابة صحيحة.</p>
    <div id="questions"></div>
    <button class="btn btn-outline btn-block" id="add-question">➕ إضافة سؤال</button>
    <div class="sticky-save">
      <div class="alert alert-error" id="save-error" hidden></div>
      <button class="btn btn-primary btn-block" id="save-btn">💾 حفظ الاختبار</button>
    </div>`;

  renderQuestions();

  document.getElementById("quiz-title").oninput = (ev) => {
    e.title = ev.target.value;
    e.dirty = true;
    if (e.title.trim()) document.getElementById("title-error").hidden = true;
  };
  document.getElementById("back-btn").onclick = () => leaveEditor();
  document.getElementById("add-question").onclick = () => {
    e.questions.push(emptyQuestion());
    e.dirty = true;
    renderQuestions();
    const cards = document.querySelectorAll(".q-editor");
    const last = cards[cards.length - 1];
    last.scrollIntoView({ behavior: "smooth", block: "start" });
    last.querySelector("textarea").focus({ preventScroll: true });
  };
  document.getElementById("save-btn").onclick = saveQuiz;
}

function renderQuestions() {
  const e = editor;
  const box = document.getElementById("questions");
  box.innerHTML = e.questions.map((q, qi) => `
    <div class="card q-editor ${q.error ? "has-error" : ""}" data-q="${qi}">
      <div class="q-head">
        <h3>السؤال ${qi + 1}</h3>
        <div class="q-tools">
          <button type="button" class="icon-btn" data-act="up" title="تحريك لأعلى" aria-label="تحريك السؤال لأعلى" ${qi === 0 ? "disabled" : ""}>▲</button>
          <button type="button" class="icon-btn" data-act="down" title="تحريك لأسفل" aria-label="تحريك السؤال لأسفل" ${qi === e.questions.length - 1 ? "disabled" : ""}>▼</button>
          <button type="button" class="icon-btn danger" data-act="del-q" title="حذف السؤال" aria-label="حذف السؤال">🗑️</button>
        </div>
      </div>
      <div class="field">
        <label for="q-text-${qi}">نص السؤال</label>
        <textarea id="q-text-${qi}" data-field="text" rows="2" placeholder="اكتب السؤال هنا">${escapeHtml(q.text)}</textarea>
      </div>
      <label>الخيارات</label>
      ${q.options.map((opt, oi) => `
        <div class="opt-row ${q.correct === oi ? "is-correct" : ""}">
          <button type="button" class="correct-toggle ${q.correct === oi ? "on" : ""}" data-act="correct" data-o="${oi}"
                  aria-label="تحديد الخيار ${oi + 1} كإجابة صحيحة" aria-pressed="${q.correct === oi}">✓</button>
          <input type="text" data-field="option" data-o="${oi}" maxlength="300" placeholder="الخيار ${oi + 1}" value="${escapeHtml(opt)}">
          <button type="button" class="icon-btn danger" data-act="del-o" data-o="${oi}" aria-label="حذف الخيار ${oi + 1}" ${q.options.length <= 2 ? "disabled" : ""}>✕</button>
        </div>`).join("")}
      <button type="button" class="btn btn-light btn-small" data-act="add-o">➕ إضافة خيار</button>
      ${q.error ? `<div class="q-error">${escapeHtml(q.error)}</div>` : ""}
    </div>`).join("");

  box.querySelectorAll(".q-editor").forEach((card) => {
    const qi = Number(card.dataset.q);
    const q = e.questions[qi];

    card.querySelectorAll("[data-field]").forEach((input) => {
      input.oninput = () => {
        if (input.dataset.field === "text") q.text = input.value;
        else q.options[Number(input.dataset.o)] = input.value;
        e.dirty = true;
      };
    });

    card.querySelectorAll("[data-act]").forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        const oi = Number(btn.dataset.o);
        if (act === "correct") {
          q.correct = oi;
        } else if (act === "add-o") {
          q.options.push("");
        } else if (act === "del-o") {
          if (q.options.length <= 2) return;
          q.options.splice(oi, 1);
          if (q.correct === oi) q.correct = -1;
          else if (q.correct > oi) q.correct--;
        } else if (act === "up" && qi > 0) {
          [e.questions[qi - 1], e.questions[qi]] = [e.questions[qi], e.questions[qi - 1]];
        } else if (act === "down" && qi < e.questions.length - 1) {
          [e.questions[qi + 1], e.questions[qi]] = [e.questions[qi], e.questions[qi + 1]];
        } else if (act === "del-q") {
          const hasContent = q.text.trim() || q.options.some((o) => o.trim());
          if (hasContent) {
            const ok = await confirmDialog(`هل تريد حذف السؤال ${qi + 1}؟`, { okText: "نعم، احذف", danger: true });
            if (!ok) return;
          }
          e.questions.splice(qi, 1);
          if (e.questions.length === 0) e.questions.push(emptyQuestion());
        } else {
          return;
        }
        e.dirty = true;
        q.error = "";
        renderQuestions();

        // إبقاء التركيز في مكان مناسب
        if (act === "add-o") {
          const inputs = document.querySelectorAll(`[data-q="${qi}"] [data-field="option"]`);
          inputs[inputs.length - 1]?.focus();
        } else if (act === "up" || act === "down") {
          const target = document.querySelector(`[data-q="${act === "up" ? qi - 1 : qi + 1}"]`);
          target?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      };
    });
  });
}

// التحقق وتجهيز البيانات للحفظ. يرجع null إذا وُجد خطأ.
function validateEditor() {
  const e = editor;
  let valid = true;
  const titleErr = document.getElementById("title-error");
  if (!e.title.trim()) {
    titleErr.textContent = "اكتب عنوان الاختبار.";
    titleErr.hidden = false;
    valid = false;
  } else {
    titleErr.hidden = true;
  }

  const clean = e.questions.map((q) => {
    q.error = "";
    const text = q.text.trim();
    const filled = [];
    let correct = -1;
    q.options.forEach((opt, oi) => {
      const t = opt.trim();
      if (!t) return;
      if (oi === q.correct) correct = filled.length;
      filled.push(t);
    });
    if (!text) q.error = "اكتب نص السؤال.";
    else if (filled.length < 2) q.error = "اكتب خيارين على الأقل.";
    else if (q.correct < 0) q.error = "حدّد الإجابة الصحيحة بالضغط على الدائرة بجانبها.";
    else if (correct < 0) q.error = "الإجابة الصحيحة المحددة فارغة. اكتب نصها أو اختر خيارًا آخر.";
    if (q.error) valid = false;
    return { text, options: filled, correct };
  });

  renderQuestions();
  if (!valid) {
    const firstErr = !e.title.trim()
      ? document.getElementById("quiz-title")
      : document.querySelector(".q-editor.has-error");
    firstErr?.scrollIntoView({ behavior: "smooth", block: "center" });
    return null;
  }
  return { title: e.title.trim(), questions: clean };
}

async function saveQuiz() {
  const e = editor;
  if (e.saving) return;
  const errBox = document.getElementById("save-error");
  errBox.hidden = true;

  const data = validateEditor();
  if (!data) {
    errBox.textContent = "يوجد نقص في بعض الأسئلة، راجع الأسئلة المحددة باللون الأحمر.";
    errBox.hidden = false;
    return;
  }

  if (e.id && e.submissions > 0) {
    const ok = await confirmDialog(
      `هذا الاختبار لديه ${e.submissions} نتيجة سابقة.\nهل تريد حفظ التعديلات؟`,
      { okText: "نعم، احفظ التعديلات" }
    );
    if (!ok) return;
  }

  const btn = document.getElementById("save-btn");
  e.saving = true;
  btn.disabled = true;
  btn.textContent = "جارٍ الحفظ...";
  try {
    if (e.id) {
      await updateDoc(doc(db, "quizzes", e.id), {
        title: data.title,
        questions: data.questions,
        updatedAt: serverTimestamp()
      });
    } else {
      const id = await generateQuizId();
      await setDoc(doc(db, "quizzes", id), {
        title: data.title,
        questions: data.questions,
        active: true,
        createdAt: serverTimestamp()
      });
    }
    e.dirty = false;
    editor = null;
    toast("تم حفظ الاختبار بنجاح ✓", "success");
    go("#/");
  } catch (err) {
    e.saving = false;
    btn.disabled = false;
    btn.textContent = "💾 حفظ الاختبار";
    errBox.textContent = "تعذّر الحفظ. " + friendlyError(err);
    errBox.hidden = false;
  }
}

async function leaveEditor() {
  if (editor && editor.dirty) {
    const ok = await confirmDialog("لديك تغييرات لم تُحفظ. هل تريد الخروج بدون حفظ؟", { okText: "نعم، اخرج بدون حفظ", danger: true });
    if (!ok) return;
  }
  editor = null;
  go("#/");
}

window.addEventListener("beforeunload", (ev) => {
  if (editor && editor.dirty) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

// ===== النتائج =====

let results = null; // { quizId, title, questions, items, sort }

async function showResults(quizId) {
  editor = null;
  showLoading("جارٍ تحميل النتائج...");
  try {
    const [quizSnap, subsSnap] = await Promise.all([
      getDoc(doc(db, "quizzes", quizId)),
      getDocs(collection(db, "quizzes", quizId, "submissions"))
    ]);
    if (!quizSnap.exists()) {
      showErrorBox("هذا الاختبار غير موجود. ربما حُذف.", () => go("#/"));
      return;
    }
    const data = quizSnap.data();
    results = {
      quizId,
      title: data.title || "اختبار",
      questions: data.questions || [],
      sort: results && results.quizId === quizId ? results.sort : "time",
      items: subsSnap.docs.map((d) => {
        const s = d.data();
        return {
          key: d.id,
          name: s.name || d.id,
          score: Number(s.score) || 0,
          total: Number(s.total) || 0,
          answers: Array.isArray(s.answers) ? s.answers : [],
          createdAt: toDate(s.createdAt)
        };
      })
    };
    document.title = `نتائج: ${results.title} — ${SITE_NAME}`;
    renderResults();
  } catch (err) {
    showErrorBox("تعذّر تحميل النتائج. " + friendlyError(err), () => showResults(quizId));
  }
}

function sortedItems() {
  const items = [...results.items];
  if (results.sort === "name") {
    items.sort((a, b) => a.name.localeCompare(b.name, "ar"));
  } else if (results.sort === "score") {
    items.sort((a, b) => (b.score / (b.total || 1)) - (a.score / (a.total || 1)) || b.score - a.score || a.name.localeCompare(b.name, "ar"));
  } else {
    items.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  }
  return items;
}

function renderResults() {
  const r = results;
  const items = sortedItems();
  const avg = items.length
    ? (items.reduce((s, x) => s + x.score, 0) / items.length).toFixed(1).replace(/\.0$/, "")
    : "—";

  app.innerHTML = `
    <div class="page-head">
      <h2>النتائج</h2>
      <button class="btn btn-light btn-small" id="back-btn">→ رجوع</button>
    </div>
    <div class="card card-accent">
      <h3 style="margin:0;color:var(--green-dark)">${escapeHtml(r.title)}</h3>
    </div>
    <div class="summary-row">
      <div class="summary-item"><span class="num">${items.length}</span>عدد الممتحنين</div>
      <div class="summary-item"><span class="num">${avg}</span>متوسط الدرجة من ${r.questions.length}</div>
    </div>
    ${items.length ? `
      <button class="btn btn-gold btn-block" id="export-btn" style="margin-bottom:16px">📥 تصدير إلى Excel</button>
      <div class="sort-bar" role="group" aria-label="ترتيب النتائج">
        <span class="muted">ترتيب حسب:</span>
        <button class="btn btn-light ${r.sort === "time" ? "active" : ""}" data-sort="time">الوقت</button>
        <button class="btn btn-light ${r.sort === "score" ? "active" : ""}" data-sort="score">الدرجة</button>
        <button class="btn btn-light ${r.sort === "name" ? "active" : ""}" data-sort="name">الاسم</button>
      </div>
      <p class="muted" style="font-size:0.95rem">اضغط على الاسم لعرض تفاصيل إجاباته.</p>
      ${items.map((x) => `
        <div class="card result-card">
          <div class="result-main">
            <button class="result-name" data-view="${escapeHtml(x.key)}">${escapeHtml(x.name)}</button>
            <div class="result-score">${x.score} من ${x.total}</div>
            <div class="result-time">${escapeHtml(formatDateTime(x.createdAt))}</div>
          </div>
          <button class="icon-btn danger" data-del="${escapeHtml(x.key)}" aria-label="حذف نتيجة ${escapeHtml(x.name)}" title="حذف النتيجة">🗑️</button>
        </div>`).join("")}
    ` : `
      <div class="card empty-state">
        <div class="big-icon" aria-hidden="true">📭</div>
        <p>لم يؤدِّ أحد هذا الاختبار بعد.</p>
      </div>`}`;

  document.getElementById("back-btn").onclick = () => go("#/");
  document.getElementById("export-btn")?.addEventListener("click", exportExcel);
  app.querySelectorAll("[data-sort]").forEach((b) => {
    b.onclick = () => { r.sort = b.dataset.sort; renderResults(); };
  });
  app.querySelectorAll("[data-view]").forEach((b) => {
    b.onclick = () => showAnswerDetails(r.items.find((x) => x.key === b.dataset.view));
  });
  app.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => deleteResult(r.items.find((x) => x.key === b.dataset.del));
  });
}

function showAnswerDetails(item) {
  if (!item) return;
  const qs = results.questions;
  const mismatch = item.answers.length !== qs.length;
  const rows = qs.map((q, idx) => {
    const ans = item.answers[idx];
    const ok = ans === q.correct;
    const yours = typeof ans === "number" && ans >= 0 && ans < q.options.length ? q.options[ans] : "لم يُجب";
    return `
      <div class="review-item ${ok ? "is-correct" : "is-wrong"}">
        <div class="review-q">${idx + 1}. ${escapeHtml(q.text)}</div>
        <div class="review-ans ${ok ? "correct" : "wrong"}">
          <span class="lbl">${ok ? "✓ إجابته صحيحة:" : "✗ إجابته:"}</span> ${escapeHtml(yours)}
        </div>
        ${ok ? "" : `<div class="review-ans correct"><span class="lbl">الإجابة الصحيحة:</span> ${escapeHtml(q.options[q.correct] ?? "—")}</div>`}
      </div>`;
  }).join("");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="max-width:640px">
      <h2 class="modal-title">${escapeHtml(item.name)}</h2>
      <p><strong>${item.score} من ${item.total}</strong> — <span class="muted">${escapeHtml(formatDateTime(item.createdAt))}</span></p>
      ${mismatch ? `<div class="alert alert-warn">تم تعديل الاختبار بعد أداء هذا الشخص، لذلك قد لا تتطابق المراجعة تمامًا.</div>` : ""}
      ${rows}
      <button class="btn btn-primary btn-block" data-close style="position:sticky;bottom:0">إغلاق</button>
    </div>`;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  overlay.querySelector("[data-close]").onclick = close;
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  overlay.querySelector(".modal").scrollTop = 0;
}

async function deleteResult(item) {
  if (!item) return;
  const ok = await confirmDialog(
    `هل تريد حذف نتيجة «${item.name}»؟\nبعد الحذف يستطيع هذا الشخص أداء الاختبار مرة أخرى.`,
    { okText: "نعم، احذف النتيجة", danger: true }
  );
  if (!ok) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "quizzes", results.quizId, "submissions", item.key));
    batch.delete(doc(db, "quizzes", results.quizId, "names", item.key));
    await batch.commit();
    results.items = results.items.filter((x) => x.key !== item.key);
    toast("تم حذف النتيجة", "success");
    renderResults();
  } catch (err) {
    toast("تعذّر الحذف. " + friendlyError(err), "error");
  }
}

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SHEETJS_URL;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error("load failed"));
    document.head.appendChild(s);
  });
}

function excelDate(d) {
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function exportExcel() {
  const btn = document.getElementById("export-btn");
  btn.disabled = true;
  btn.textContent = "جارٍ تجهيز الملف...";
  try {
    const XLSX = await loadSheetJS();
    const rows = sortedItems().map((x) => ({
      "الاسم": x.name,
      "عدد الإجابات الصحيحة": x.score,
      "عدد الأسئلة": x.total,
      "التاريخ والوقت": excelDate(x.createdAt)
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 32 }, { wch: 22 }, { wch: 14 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, "النتائج");
    const safeTitle = results.title.replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60) || "اختبار";
    XLSX.writeFile(wb, `نتائج - ${safeTitle}.xlsx`);
    toast("تم تنزيل ملف Excel ✓", "success");
  } catch {
    toast("تعذّر تجهيز ملف Excel. تأكد من الاتصال بالإنترنت.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "📥 تصدير إلى Excel";
  }
}

// ===== التنقل =====

function route() {
  if (!currentUser) return;
  const hash = location.hash || "#/";
  lastHash = hash;
  let m;
  if (hash === "#/new") showEditor(null);
  else if ((m = hash.match(/^#\/edit\/([A-Za-z0-9]+)$/))) showEditor(m[1]);
  else if ((m = hash.match(/^#\/results\/([A-Za-z0-9]+)$/))) showResults(m[1]);
  else showList();
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", async () => {
  if (ignoreHashChange) {
    ignoreHashChange = false;
    return;
  }
  // زر الرجوع في الهاتف أثناء وجود تغييرات غير محفوظة
  if (editor && editor.dirty) {
    const target = location.hash;
    ignoreHashChange = true;
    location.hash = lastHash; // نعود مؤقتًا
    const ok = await confirmDialog("لديك تغييرات لم تُحفظ. هل تريد الخروج بدون حفظ؟", { okText: "نعم، اخرج بدون حفظ", danger: true });
    if (!ok) return;
    editor = null;
    location.hash = target;
    return;
  }
  route();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    showLogin();
    return;
  }
  if ((user.email || "").toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    currentUser = null;
    await signOut(auth);
    showLogin("هذا الحساب ليس حساب المدير.");
    return;
  }
  currentUser = user;
  logoutBtn.hidden = false;
  route();
});
