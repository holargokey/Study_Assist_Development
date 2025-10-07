// static/js/script.js
document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  // --- Small helpers ---
  const $ = (id) => document.getElementById(id);
  const statusEl = $("opStatus"); // single status target

  async function postJSON(url, bodyObj) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyObj ? JSON.stringify(bodyObj) : null,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      throw new Error(data.error || `Request failed: ${resp.status}`);
    }
    return data;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // --- Elements from your HTML ---

  const quizRange   = $("quizRange");
  const rangeValue  = $("rangeValue");
  const browseBtn   = $("browseBtn");
  const fileInput   = $("fileInput");
  const fileStatus  = $("fileStatus");
  const filePreview = $("filePreview");
  const generateBtn = $("generateBtn");
  const questionInp = $("questionInput");
  const askBtn      = $("askBtn");
  const exportDiv   = $("export-options");
  const quizBox     = $("quizBox");
  const quizList    = $("quizList");
  const quizStatus  = $("quizStatus");   // small line under "Generate Questions" button
  const quizResults = $("quizResults");  // results area inside #quizBox
  const submitQuizBtn = $("submitQuizBtn");

  // --- Collapsible left panel with chevron handle ---
(function () {
  const leftPanel  = document.getElementById("leftPanel");
  const rightPanel = document.getElementById("rightPanel");
  const handle     = document.getElementById("sidebarHandle");

  if (!leftPanel || !rightPanel || !handle) return;

  // Apply previous state (if any)
  const saved = localStorage.getItem("sidebarCollapsed") === "true";
  applyCollapsed(saved);

  // Click + keyboard toggle
  handle.addEventListener("click", toggle);
  handle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  function toggle() {
    const nowCollapsed = leftPanel.classList.toggle("d-none"); // hide/show left
    // expand right panel when left is hidden
    rightPanel.classList.toggle("col-9", !nowCollapsed);
    rightPanel.classList.toggle("col-12", nowCollapsed);

    // Update chevron and a11y
    handle.innerHTML = nowCollapsed ? "&rsaquo;" : "&lsaquo;"; // > when hidden, < when shown
    handle.setAttribute("aria-expanded", String(!nowCollapsed));
    handle.title = nowCollapsed ? "Show sidebar" : "Collapse sidebar";

    // Remember choice
    localStorage.setItem("sidebarCollapsed", String(nowCollapsed));
  }

  function applyCollapsed(collapsed) {
    leftPanel.classList.toggle("d-none", collapsed);
    rightPanel.classList.toggle("col-9", !collapsed);
    rightPanel.classList.toggle("col-12", collapsed);
    handle.innerHTML = collapsed ? "&rsaquo;" : "&lsaquo;";
    handle.setAttribute("aria-expanded", String(!collapsed));
    handle.title = collapsed ? "Show sidebar" : "Collapse sidebar";
  }
})();


  // ---- 1) Range -> label (and initial fill for Chrome/Edge/Safari) ----
  if (quizRange && rangeValue) {
    const updateRangeUI = () => {
      rangeValue.textContent = quizRange.value;
      const min = parseFloat(quizRange.min) || 0;
      const max = parseFloat(quizRange.max) || 100;
      const val = parseFloat(quizRange.value) || 0;
      const percent = ((val - min) / (max - min)) * 100;
      quizRange.style.setProperty("--progress", `${percent}%`);
    };
    updateRangeUI();
    quizRange.addEventListener("input", updateRangeUI);
  }

  // ---- 2) File picking + local .txt preview ----
  if (browseBtn && fileInput) {
    browseBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) {
        if (fileStatus)  fileStatus.textContent = "";
        if (filePreview) filePreview.textContent = "";
        return;
      }
      if (fileStatus) fileStatus.textContent = `Selected: ${file.name}`;

      if (filePreview && (file.type === "text/plain" || /\.txt$/i.test(file.name))) {
        const reader = new FileReader();
        reader.onload = (ev) => (filePreview.textContent = String(ev.target?.result || ""));
        reader.readAsText(file);
      } else if (filePreview) {
        filePreview.textContent = "📄 File selected. Preview only available for .txt files.";
      }
    });
  }

  // ---- 3) Ask a question (server) ----
  function ensureAnswerBox() {
    let box = $("answerBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "answerBox";
      box.className = "mt-3";
      box.innerHTML = `
        <div class="border rounded p-3 bg-light" id="answerText" style="white-space: pre-wrap;"></div>
      `;
      questionInp?.parentNode?.insertBefore(box, questionInp.nextSibling);
    }
    return box;
  }

  async function askQuestion() {
    const q = (questionInp?.value || "").trim();
    if (!q) { questionInp?.focus(); return; }
    if (askBtn) askBtn.disabled = true;
    setStatus("Answering...");
    try {
      const data = await postJSON("/ask", { question: q });
      ensureAnswerBox();
      const answerText = $("answerText");
      if (answerText) answerText.textContent = data.answer || "(no answer)";
      setStatus("✅ Answer ready.");
    } catch (err) {
      setStatus(`⚠️ ${err.message}`);
    } finally {
      if (askBtn) askBtn.disabled = false;
    }
  }

  if (askBtn) askBtn.addEventListener("click", askQuestion);
  if (questionInp) {
    questionInp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        askQuestion();
      }
    });
  }

  // ---- 4) Generate Quiz (server) + render + export ----
  let lastQuiz = [];

  function renderQuiz(quiz) {
    if (!quizList) return;
    quizList.innerHTML = '';
    quiz.forEach((q, idx) => {
      const correct = (q.correct || '').trim().replace(/[^A-D]/ig, '').toUpperCase(); // "A"–"D"
      const item = document.createElement('div');
      item.className = 'list-group-item';
      item.dataset.correct = correct;

      const choicesHtml = ['A','B','C','D'].map((L, i) => {
        const raw = (q.choices?.[i] || '').trim();
        const labelText = raw.replace(/^[A-D]\)\s*/i, '');
        const id = `q${idx}-${L}`;
        return `
          <div class="form-check ms-2">
            <input class="form-check-input" type="radio" name="q${idx}" id="${id}" value="${L}">
            <label class="form-check-label" for="${id}">
              <span class="badge bg-light text-dark me-2">${L}</span>${labelText || raw}
            </label>
          </div>
        `;
      }).join('');

      item.innerHTML = `
        <div class="fw-semibold mb-1">${q.question || ('Question ' + (idx + 1))}</div>
        ${choicesHtml}
      `;
      quizList.appendChild(item);
    });

    if (quizResults) quizResults.innerHTML = '';   // clear prior summary
    if (quizStatus)  quizStatus.textContent = '';  // clear status line
    if (quizBox)     quizBox.style.display = 'block';
  }

  function gradeQuiz() {
    if (!quizList) return;
    const items = [...quizList.querySelectorAll('.list-group-item')];
    const total = items.length;

    const answers = items.map((item, idx) => {
      const selected = item.querySelector('input[type="radio"]:checked');
      return {
        idx,
        selected: selected ? selected.value.toUpperCase() : null,
        correct:  (item.dataset.correct || '').toUpperCase()
      };
    });

    // Require all answered
    const unanswered = answers.filter(a => !a.selected).map(a => a.idx + 1);
    if (unanswered.length) {
      if (quizStatus)  quizStatus.textContent = `Please answer all questions before submitting. Missing: ${unanswered.join(', ')}.`;
      if (quizResults) quizResults.innerHTML = '';
      return; // ⛔ do not reveal anything yet
    }

    // Score + one summary (no per-question inline hints)
    let correctCount = 0;
    const rowsHtml = answers.map(a => {
      const ok = a.selected === a.correct;
      if (ok) correctCount++;
      return `
        <tr>
          <td>${a.idx + 1}</td>
          <td>${a.selected}</td>
          <td>${a.correct}</td>
          <td>${ok ? '<span class="badge bg-success">Correct</span>' : '<span class="badge bg-danger">Incorrect</span>'}</td>
        </tr>
      `;
    }).join('');

    const pct = Math.round((correctCount / total) * 100);
    if (quizResults) {
      quizResults.innerHTML = `
        <div class="alert alert-info mb-2">
          Score: <strong>${correctCount}/${total}</strong> (${pct}%)
        </div>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead><tr><th>#</th><th>Your Answer</th><th>Correct</th><th>Result</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `;
      quizResults.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (quizStatus) quizStatus.textContent = '✅ Graded.';
  }

  // Attach once
  if (submitQuizBtn) submitQuizBtn.addEventListener('click', gradeQuiz);

  function attachExportButtons() {
    if (!exportDiv) return;
    exportDiv.innerHTML = `
      <h6 class="mt-4">📤 Export Options</h6>
      <button id="exportCsvBtn" class="btn btn-outline-secondary me-2">Export CSV</button>
      <button id="exportPdfBtn" class="btn btn-outline-secondary">Export PDF</button>
    `;
    const exportCsvBtn = $("exportCsvBtn");
    const exportPdfBtn = $("exportPdfBtn");

    if (exportCsvBtn) {
      exportCsvBtn.addEventListener("click", () => {
        if (!lastQuiz.length || !window.Papa) return;
        const rows = lastQuiz.map((q) => ({
          question: q.question,
          choiceA: q.choices?.[0] || "",
          choiceB: q.choices?.[1] || "",
          choiceC: q.choices?.[2] || "",
          choiceD: q.choices?.[3] || "",
          correct: q.correct || "",
        }));
        const csv = Papa.unparse(rows);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "quiz.csv";
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    if (exportPdfBtn) {
      exportPdfBtn.addEventListener("click", () => {
        if (!lastQuiz.length || !window.jspdf) return;
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        let y = 10;
        doc.setFontSize(12);

        lastQuiz.forEach((q, i) => {
          const qLines = doc.splitTextToSize(`${i + 1}. ${q.question}`, 180);
          doc.text(qLines, 10, y); y += qLines.length * 6 + 2;
          (q.choices || []).forEach((c) => {
            const cl = doc.splitTextToSize(`- ${c}`, 175);
            doc.text(cl, 14, y); y += cl.length * 6 + 1;
          });
          doc.text(`Answer: ${q.correct}`, 10, y); y += 10;
          if (y > 270) { doc.addPage(); y = 10; }
        });

        doc.save("quiz.pdf");
      });
    }
  }

  if (generateBtn && quizRange) {
    generateBtn.addEventListener("click", async () => {
      const num = parseInt(quizRange.value || "5", 10);
      generateBtn.disabled = true;
      if (quizStatus) quizStatus.textContent = `Generating ${num} questions...`;
      try {
        const data = await postJSON("/generate_quiz", { num_questions: num });
        lastQuiz = data.quiz || [];
        renderQuiz(lastQuiz);
        attachExportButtons();
        if (quizStatus) quizStatus.textContent = '✅ Quiz ready.';
      } catch (err) {
        if (quizStatus) quizStatus.textContent = `⚠️ ${err.message}`;
      } finally {
        generateBtn.disabled = false;
      }
    });
  }
});
