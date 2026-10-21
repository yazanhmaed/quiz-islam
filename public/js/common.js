// أدوات مشتركة بين الصفحتين

// توحيد الاسم للمقارنة: حذف التشكيل والمسافات الزائدة، وتوحيد الحروف المتشابهة
export function normalizeName(name) {
  return String(name || "")
    .replace(/[ً-ٰٟۖ-ۭ]/g, "") // التشكيل
    .replace(/ـ/g, "")                               // التطويل ـ
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\/\\.#$\[\]]/g, " ")                       // رموز غير مسموحة في معرّف المستند
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 100);
}

// تنظيف الاسم للعرض (بدون تغيير الحروف)
export function cleanDisplayName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 100);
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// تحويل الأرقام إلى صيغة التاريخ والوقت العربية
export function formatDateTime(date) {
  if (!date) return "—";
  try {
    return new Intl.DateTimeFormat("ar", {
      year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit"
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts === "number") return new Date(ts);
  return null;
}

// قراءة وكتابة آمنة في ذاكرة الجهاز
export const store = {
  get(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* تجاهل */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* تجاهل */ }
  }
};

// رسالة قصيرة تظهر أسفل الشاشة
let toastTimer;
export function toast(message, type = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = "toast show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast " + type; }, 3500);
}

// نافذة تأكيد كبيرة وواضحة. ترجع true عند الموافقة.
export function confirmDialog(message, { okText = "نعم", cancelText = "إلغاء", danger = false, title = "" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        ${title ? `<h2 class="modal-title">${escapeHtml(title)}</h2>` : ""}
        <p class="modal-text">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${escapeHtml(okText)}</button>
          <button type="button" class="btn btn-light" data-cancel>${escapeHtml(cancelText)}</button>
        </div>
      </div>`;
    const close = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    overlay.querySelector("[data-ok]").onclick = () => close(true);
    overlay.querySelector("[data-cancel]").onclick = () => close(false);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector("[data-ok]").focus();
  });
}

// رسالة خطأ مفهومة من أخطاء Firebase
export function friendlyError(err) {
  const code = err && err.code ? String(err.code) : "";
  if (code.includes("unavailable") || code.includes("network") || !navigator.onLine) {
    return "تعذّر الاتصال بالإنترنت. تأكد من الاتصال ثم حاول مرة أخرى.";
  }
  if (code.includes("permission-denied")) return "لا تملك صلاحية لهذا الإجراء.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found") || code.includes("invalid-email")) {
    return "الإيميل أو كلمة المرور غير صحيحة.";
  }
  if (code.includes("too-many-requests")) return "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.";
  return "حدث خطأ غير متوقع. حاول مرة أخرى.";
}
